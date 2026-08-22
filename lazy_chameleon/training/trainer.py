"""
Training pipeline for distilling Opus-level reasoning into Flash models.
Supports: LoRA fine-tuning via transformers/peft, OpenAI fine-tuning API,
           data preparation only (export JSONL for external training).
"""

import json
import logging
from dataclasses import dataclass, asdict, field
from pathlib import Path
from typing import Optional, Callable, Any, Tuple, List, Dict
import hashlib
import time
from datetime import datetime

logger = logging.getLogger(__name__)


@dataclass
class TrainingConfig:
    """Configuration for LoRA fine-tuning."""
    model_name: str
    lora_r: int = 8
    lora_alpha: int = 16
    lora_dropout: float = 0.05
    learning_rate: float = 5e-4
    num_epochs: int = 3
    batch_size: int = 8
    gradient_accumulation_steps: int = 4
    warmup_steps: int = 500
    max_seq_length: int = 4096
    output_dir: str = "./outputs"
    eval_steps: int = 500
    save_steps: int = 500
    use_flash_attention: bool = True
    bf16: bool = True
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary."""
        return asdict(self)


class LoRATrainer:
    """Fine-tune models using LoRA with HuggingFace transformers + peft."""
    
    def __init__(self, config: TrainingConfig):
        self.config = config
        self.model = None
        self.tokenizer = None
        self.trainer = None
        self._validate_imports()
        
    def _validate_imports(self):
        """Check for required ML libraries."""
        try:
            import transformers
            import peft
            import torch
        except ImportError as e:
            logger.warning(
                f"ML dependencies not installed: {e}. "
                "Install with: pip install transformers peft torch accelerate"
            )
    
    def prepare_model(self):
        """Load base model and apply LoRA config."""
        try:
            from transformers import AutoModelForCausalLM, AutoTokenizer
            from peft import get_peft_model, LoraConfig, TaskType
            import torch
        except ImportError as e:
            raise RuntimeError(
                f"Cannot prepare model without ML deps: {e}. "
                "Install: pip install transformers peft torch"
            ) from e
        
        logger.info(f"Loading base model: {self.config.model_name}")
        
        # Load tokenizer
        self.tokenizer = AutoTokenizer.from_pretrained(
            self.config.model_name,
            trust_remote_code=True
        )
        if self.tokenizer.pad_token is None:
            self.tokenizer.pad_token = self.tokenizer.eos_token
        
        # Load model with optimizations
        model_kwargs = {
            "trust_remote_code": True,
            "device_map": "auto",
        }
        if self.config.bf16:
            model_kwargs["torch_dtype"] = torch.bfloat16
        
        self.model = AutoModelForCausalLM.from_pretrained(
            self.config.model_name,
            **model_kwargs
        )
        
        # Apply LoRA
        lora_config = LoraConfig(
            r=self.config.lora_r,
            lora_alpha=self.config.lora_alpha,
            lora_dropout=self.config.lora_dropout,
            bias="none",
            task_type=TaskType.CAUSAL_LM,
            target_modules=self._get_target_modules(),
        )
        
        self.model = get_peft_model(self.model, lora_config)
        logger.info(f"Model prepared with LoRA (r={self.config.lora_r})")
        
        return self.model
    
    def _get_target_modules(self) -> List[str]:
        """Get target modules for LoRA based on model architecture."""
        # Common naming patterns for different model families
        common_targets = ["q_proj", "v_proj", "k_proj", "o_proj"]
        return common_targets
    
    def train(self, train_dataset, eval_dataset=None):
        """Full training loop."""
        try:
            from transformers import Trainer, TrainingArguments
        except ImportError as e:
            raise RuntimeError(f"Cannot train without transformers: {e}") from e
        
        if self.model is None:
            self.prepare_model()
        
        # Create output directory
        Path(self.config.output_dir).mkdir(parents=True, exist_ok=True)
        
        # Training arguments
        training_args = TrainingArguments(
            output_dir=self.config.output_dir,
            num_train_epochs=self.config.num_epochs,
            per_device_train_batch_size=self.config.batch_size,
            per_device_eval_batch_size=self.config.batch_size,
            gradient_accumulation_steps=self.config.gradient_accumulation_steps,
            learning_rate=self.config.learning_rate,
            warmup_steps=self.config.warmup_steps,
            logging_steps=100,
            eval_strategy="steps" if eval_dataset else "no",
            eval_steps=self.config.eval_steps if eval_dataset else None,
            save_strategy="steps",
            save_steps=self.config.save_steps,
            bf16=self.config.bf16,
            logging_dir=f"{self.config.output_dir}/logs",
            report_to=["tensorboard"],
            dataloader_pin_memory=True,
            optim="paged_adamw_32bit",
        )
        
        self.trainer = Trainer(
            model=self.model,
            args=training_args,
            train_dataset=train_dataset,
            eval_dataset=eval_dataset,
            tokenizer=self.tokenizer,
            data_collator=self._get_data_collator(),
        )
        
        logger.info("Starting training...")
        result = self.trainer.train()
        logger.info(f"Training completed: {result}")
        
        return result
    
    def _get_data_collator(self):
        """Get appropriate data collator for causal LM."""
        try:
            from transformers import DataCollatorForLanguageModeling
            return DataCollatorForLanguageModeling(
                tokenizer=self.tokenizer,
                mlm=False,
            )
        except ImportError:
            return None
    
    def save_checkpoint(self, path: str):
        """Save model checkpoint."""
        if self.model is None:
            raise RuntimeError("Model not initialized. Call prepare_model() first.")
        
        Path(path).mkdir(parents=True, exist_ok=True)
        
        # Save LoRA weights
        self.model.save_pretrained(path)
        
        # Save tokenizer
        if self.tokenizer:
            self.tokenizer.save_pretrained(path)
        
        # Save config
        config_path = Path(path) / "training_config.json"
        with open(config_path, "w") as f:
            json.dump(self.config.to_dict(), f, indent=2)
        
        logger.info(f"Checkpoint saved to {path}")
    
    def merge_and_export(self, path: str):
        """Merge LoRA weights into base model and save."""
        if self.model is None:
            raise RuntimeError("Model not initialized.")
        
        logger.info("Merging LoRA weights...")
        
        try:
            merged_model = self.model.merge_and_unload()
        except AttributeError:
            # Model might not have merge_and_unload if not LoRA
            merged_model = self.model
        
        Path(path).mkdir(parents=True, exist_ok=True)
        
        merged_model.save_pretrained(path)
        if self.tokenizer:
            self.tokenizer.save_pretrained(path)
        
        logger.info(f"Merged model exported to {path}")


class OpenAIFineTuner:
    """Fine-tune models via OpenAI-compatible fine-tuning API."""
    
    def __init__(self, api_key: str, base_url: Optional[str] = None):
        self.api_key = api_key
        self.base_url = base_url or "https://api.openai.com/v1"
        self._client = None
    
    @property
    def client(self):
        """Lazy-load OpenAI client."""
        if self._client is None:
            try:
                from openai import OpenAI
                self._client = OpenAI(
                    api_key=self.api_key,
                    base_url=self.base_url
                )
            except ImportError as e:
                raise RuntimeError(
                    f"OpenAI library not installed: {e}. "
                    "Install with: pip install openai"
                ) from e
        return self._client
    
    def prepare_data(
        self,
        datapoints: List[Any],
        output_path: str,
        include_eval: bool = True
    ) -> Tuple[str, Optional[str]]:
        """Convert DataPoints to OpenAI fine-tuning JSONL format.
        
        Returns: (train_path, eval_path)
        """
        Path(output_path).parent.mkdir(parents=True, exist_ok=True)
        
        train_lines = []
        eval_lines = []
        
        for i, dp in enumerate(datapoints):
            # Convert to OpenAI format
            message = {
                "role": "user" if not hasattr(dp, 'is_assistant') else "assistant",
                "content": getattr(dp, 'input', '') or getattr(dp, 'prompt', ''),
            }
            
            completion = {
                "role": "assistant",
                "content": getattr(dp, 'output', '') or getattr(dp, 'response', ''),
            }
            
            entry = {
                "messages": [message, completion]
            }
            
            # Split train/eval (90/10)
            if include_eval and i % 10 == 0:
                eval_lines.append(json.dumps(entry))
            else:
                train_lines.append(json.dumps(entry))
        
        # Write train file
        train_path = output_path.replace(".jsonl", "_train.jsonl")
        with open(train_path, "w") as f:
            f.write("\n".join(train_lines))
        
        logger.info(f"Wrote {len(train_lines)} training examples to {train_path}")
        
        # Write eval file
        eval_path = None
        if eval_lines:
            eval_path = output_path.replace(".jsonl", "_eval.jsonl")
            with open(eval_path, "w") as f:
                f.write("\n".join(eval_lines))
            logger.info(f"Wrote {len(eval_lines)} eval examples to {eval_path}")
        
        return train_path, eval_path
    
    def submit_job(
        self,
        file_path: str,
        model: str = "gpt-3.5-turbo",
        suffix: Optional[str] = None
    ) -> str:
        """Submit fine-tuning job, return job ID."""
        logger.info(f"Uploading file {file_path}...")
        
        with open(file_path, "rb") as f:
            response = self.client.files.create(
                file=f,
                purpose="fine-tune"
            )
        file_id = response.id
        logger.info(f"File uploaded: {file_id}")
        
        # Submit job
        job_kwargs = {
            "training_file": file_id,
            "model": model,
        }
        if suffix:
            job_kwargs["suffix"] = suffix
        
        job = self.client.fine_tuning.jobs.create(**job_kwargs)
        logger.info(f"Fine-tuning job submitted: {job.id}")
        
        return job.id
    
    def check_status(self, job_id: str) -> Dict[str, Any]:
        """Check job status."""
        job = self.client.fine_tuning.jobs.retrieve(job_id)
        
        status_dict = {
            "job_id": job.id,
            "status": job.status,
            "created_at": job.created_at,
            "updated_at": job.updated_at,
            "model": getattr(job, 'model', None),
            "fine_tuned_model": getattr(job, 'fine_tuned_model', None),
            "training_file": getattr(job, 'training_file', None),
            "validation_file": getattr(job, 'validation_file', None),
            "result_files": getattr(job, 'result_files', []),
        }
        
        return status_dict
    
    def download_model(self, job_id: str, output_path: str):
        """Download fine-tuned model info (API returns model name only)."""
        job = self.client.fine_tuning.jobs.retrieve(job_id)
        
        if job.status != "succeeded":
            raise RuntimeError(f"Job {job_id} status is {job.status}, not succeeded")
        
        model_name = job.fine_tuned_model
        
        info = {
            "job_id": job_id,
            "model_name": model_name,
            "base_model": job.model,
            "status": job.status,
            "created_at": str(job.created_at),
            "completed_at": str(job.updated_at),
        }
        
        Path(output_path).parent.mkdir(parents=True, exist_ok=True)
        with open(output_path, "w") as f:
            json.dump(info, f, indent=2)
        
        logger.info(f"Model info saved to {output_path}: {model_name}")


class DataPreparer:
    """Format training data in various formats."""
    
    @staticmethod
    def format_for_chatml(datapoints: List[Any]) -> List[Dict[str, Any]]:
        """Format for ChatML (OpenAI's chat format)."""
        formatted = []
        
        for dp in datapoints:
            # Extract input/output
            user_input = getattr(dp, 'input', '') or getattr(dp, 'prompt', '')
            assistant_output = getattr(dp, 'output', '') or getattr(dp, 'response', '')
            
            formatted.append({
                "messages": [
                    {"role": "user", "content": user_input},
                    {"role": "assistant", "content": assistant_output},
                ]
            })
        
        return formatted
    
    @staticmethod
    def format_for_alpaca(datapoints: List[Any]) -> List[Dict[str, Any]]:
        """Format for Alpaca instruction-following."""
        formatted = []
        
        for dp in datapoints:
            instruction = getattr(dp, 'instruction', '') or getattr(dp, 'prompt', '')
            input_text = getattr(dp, 'input_text', '')
            output_text = getattr(dp, 'output', '') or getattr(dp, 'response', '')
            
            formatted.append({
                "instruction": instruction,
                "input": input_text,
                "output": output_text,
            })
        
        return formatted
    
    @staticmethod
    def format_for_sharegpt(datapoints: List[Any]) -> List[Dict[str, Any]]:
        """Format for ShareGPT conversation style."""
        formatted = []
        
        for dp in datapoints:
            user_msg = getattr(dp, 'input', '') or getattr(dp, 'prompt', '')
            assistant_msg = getattr(dp, 'output', '') or getattr(dp, 'response', '')
            
            formatted.append({
                "conversations": [
                    {"from": "human", "value": user_msg},
                    {"from": "gpt", "value": assistant_msg},
                ]
            })
        
        return formatted
    
    @staticmethod
    def create_dpo_pairs(
        datapoints: List[Any],
        rejected_fn: Callable[[Any], str]
    ) -> List[Dict[str, Any]]:
        """Create DPO (Direct Preference Optimization) training pairs.
        
        Args:
            datapoints: List of high-quality responses (chosen)
            rejected_fn: Function to generate rejected responses
        
        Returns:
            List of DPO pairs: {prompt, chosen, rejected}
        """
        pairs = []
        
        for dp in datapoints:
            prompt = getattr(dp, 'input', '') or getattr(dp, 'prompt', '')
            chosen = getattr(dp, 'output', '') or getattr(dp, 'response', '')
            rejected = rejected_fn(dp)
            
            pairs.append({
                "prompt": prompt,
                "chosen": chosen,
                "rejected": rejected,
            })
        
        return pairs
    
    @staticmethod
    def tokenize_and_pack(
        datapoints: List[Any],
        tokenizer: Any,
        max_length: int = 4096
    ) -> List[Dict[str, Any]]:
        """Tokenize and pack sequences for efficient training.
        
        Returns: List of packed examples with input_ids, attention_mask, labels
        """
        try:
            import torch
        except ImportError as e:
            raise RuntimeError(f"torch not installed: {e}") from e
        
        packed_examples = []
        buffer_ids = []
        buffer_masks = []
        
        for dp in datapoints:
            text = getattr(dp, 'output', '') or getattr(dp, 'response', '')
            
            # Tokenize
            tokens = tokenizer(
                text,
                truncation=True,
                max_length=max_length,
                return_tensors=None,
            )
            
            input_ids = tokens["input_ids"]
            attention_mask = tokens.get("attention_mask", [1] * len(input_ids))
            
            # Buffer and pack sequences
            buffer_ids.extend(input_ids)
            buffer_masks.extend(attention_mask)
            
            # When buffer reaches max_length, create example
            if len(buffer_ids) >= max_length:
                packed_example = {
                    "input_ids": buffer_ids[:max_length],
                    "attention_mask": buffer_masks[:max_length],
                    "labels": buffer_ids[:max_length],  # Same as input for CLM
                }
                packed_examples.append(packed_example)
                
                # Keep overflow for next example
                buffer_ids = buffer_ids[max_length:]
                buffer_masks = buffer_masks[max_length:]
        
        # Pack remaining
        if buffer_ids:
            # Pad to max_length
            padding_length = max_length - len(buffer_ids)
            buffer_ids.extend([tokenizer.pad_token_id] * padding_length)
            buffer_masks.extend([0] * padding_length)
            
            packed_examples.append({
                "input_ids": buffer_ids[:max_length],
                "attention_mask": buffer_masks[:max_length],
                "labels": buffer_ids[:max_length],
            })
        
        return packed_examples
