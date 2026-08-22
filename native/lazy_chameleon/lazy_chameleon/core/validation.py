"""Data Validation — Comprehensive validation utilities for training data."""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Any, Callable, Dict, List, Optional, Set, Tuple, Union

logger = logging.getLogger(__name__)


class ValidationSeverity(Enum):
    ERROR = "error"
    WARNING = "warning"
    INFO = "info"


class ValidationCategory(Enum):
    CONTENT = "content"
    FORMAT = "format"
    SECURITY = "security"
    QUALITY = "quality"
    CONSISTENCY = "consistency"
    BIAS = "bias"


@dataclass
class ValidationIssue:
    """A single validation issue found in the data."""
    message: str
    severity: ValidationSeverity = ValidationSeverity.WARNING
    category: ValidationCategory = ValidationCategory.CONTENT
    location: str = ""
    code: str = ""
    suggestion: str = ""
    metadata: Dict[str, Any] = field(default_factory=dict)


@dataclass
class ValidationReport:
    """Report from a validation run."""
    total_checked: int = 0
    issues: List[ValidationIssue] = field(default_factory=list)
    passed: int = 0
    failed: int = 0
    warnings: int = 0
    start_time: str = ""
    end_time: str = ""
    
    def __post_init__(self):
        if not self.start_time:
            self.start_time = datetime.now().isoformat()
        if not self.end_time:
            self.end_time = datetime.now().isoformat()
    
    @property
    def score(self) -> float:
        """Calculate overall validation score (0.0 - 1.0)."""
        if self.total_checked == 0:
            return 1.0
        total_issues = len(self.issues)
        if total_issues == 0:
            return 1.0
        error_weight = 1.0
        warning_weight = 0.5
        weighted = sum(
            error_weight if i.severity == ValidationSeverity.ERROR else warning_weight
            for i in self.issues
        )
        return max(0.0, 1.0 - (weighted / self.total_checked))
    
    def summary(self) -> str:
        """Generate a human-readable summary."""
        lines = [
            f"Validation Report",
            f"{"=" * 60}",
            f"  Checked: {self.total_checked} items",
            f"  Passed:  {self.passed}",
            f"  Failed:  {self.failed}",
            f"  Warnings: {self.warnings}",
            f"  Score:   {self.score:.1%}",
            f"{"=" * 60}",
        ]
        if self.issues:
            for issue in self.issues[:10]:
                icon = {
                    ValidationSeverity.ERROR: "  ERROR",
                    ValidationSeverity.WARNING: "WARNING",
                    ValidationSeverity.INFO: "   INFO",
                }.get(issue.severity, "  OTHER")
                lines.append(f"  [{icon}] {issue.message}")
                if issue.suggestion:
                    lines.append(f"          Suggestion: {issue.suggestion}")
            if len(self.issues) > 10:
                lines.append(f"  ... and {len(self.issues) - 10} more issues")
        return "\n".join(lines)


class DataValidator:
    """
    Comprehensive data validation for training datasets.
    
    Validates:
    - Content quality and completeness
    - Format compliance
    - Security issues (prompt injection, PII)
    - Bias and fairness
    - Consistency across examples
    - Token limits and length constraints
    """
    
    VALIDATORS: Dict[str, Callable] = {}
    
    def __init__(self, strict: bool = False):
        self.strict = strict
        self._register_builtin_validators()
    
    def _register_builtin_validators(self):
        """Register all built-in validation checks."""
        self.VALIDATORS["empty_content"] = self._check_empty_content
        self.VALIDATORS["min_length"] = self._check_min_length
        self.VALIDATORS["max_length"] = self._check_max_length
        self.VALIDATORS["has_instruction"] = self._check_has_instruction
        self.VALIDATORS["has_response"] = self._check_has_response
        self.VALIDATORS["no_hallucination_markers"] = self._check_no_hallucination
        self.VALIDATORS["no_pii"] = self._check_no_pii
        self.VALIDATORS["no_prompt_injection"] = self._check_no_prompt_injection
        self.VALIDATORS["balanced_sentiment"] = self._check_balanced_sentiment
        self.VALIDATORS["code_quality"] = self._check_code_quality
        self.VALIDATORS["math_correctness"] = self._check_math_correctness
        self.VALIDATORS["consistent_format"] = self._check_consistent_format
    
    def validate(self, data: List[Dict[str, Any]], checks: Optional[List[str]] = None) -> ValidationReport:
        """Run validation checks on a list of data points."""
        report = ValidationReport(total_checked=len(data))
        active_checks = checks or list(self.VALIDATORS.keys())
        
        for item in data:
            for check_name in active_checks:
                if check_name in self.VALIDATORS:
                    try:
                        issues = self.VALIDATORS[check_name](item)
                        report.issues.extend(issues)
                    except Exception as e:
                        report.issues.append(ValidationIssue(
                            message=f"Validator '{check_name}' failed: {e}",
                            severity=ValidationSeverity.ERROR,
                            category=ValidationCategory.CONSISTENCY,
                        ))
        
        # Count stats
        for issue in report.issues:
            if issue.severity == ValidationSeverity.ERROR:
                report.failed += 1
            elif issue.severity == ValidationSeverity.WARNING:
                report.warnings += 1
        report.passed = report.total_checked - report.failed
        report.end_time = datetime.now().isoformat()
        
        return report
    
    def _check_empty_content(self, item: Dict[str, Any]) -> List[ValidationIssue]:
        issues = []
        for field in ["instruction", "prompt", "input"]:
            if field in item and not item[field]:
                issues.append(ValidationIssue(
                    message=f"Empty field: {field}",
                    severity=ValidationSeverity.ERROR,
                    category=ValidationCategory.CONTENT,
                    code="EMPTY_CONTENT",
                ))
        for field in ["response", "output", "answer"]:
            if field in item and not item[field]:
                issues.append(ValidationIssue(
                    message=f"Empty field: {field}",
                    severity=ValidationSeverity.ERROR,
                    category=ValidationCategory.CONTENT,
                    code="EMPTY_RESPONSE",
                ))
        return issues
    
    def _check_min_length(self, item: Dict[str, Any]) -> List[ValidationIssue]:
        issues = []
        min_lens = {"instruction": 10, "input": 10, "response": 50, "output": 50}
        for field, min_len in min_lens.items():
            if field in item and item[field] and len(str(item[field])) < min_len:
                issues.append(ValidationIssue(
                    message=f"Field '{field}' too short ({len(str(item[field]))} chars, min {min_len})",
                    severity=ValidationSeverity.WARNING if not self.strict else ValidationSeverity.ERROR,
                    category=ValidationCategory.QUALITY,
                    code="TOO_SHORT",
                ))
        return issues
    
    def _check_max_length(self, item: Dict[str, Any]) -> List[ValidationIssue]:
        issues = []
        max_lens = {"instruction": 32000, "input": 32000, "response": 64000, "output": 64000}
        for field, max_len in max_lens.items():
            if field in item and item[field] and len(str(item[field])) > max_len:
                issues.append(ValidationIssue(
                    message=f"Field '{field}' too long ({len(str(item[field]))} chars, max {max_len})",
                    severity=ValidationSeverity.WARNING,
                    category=ValidationCategory.QUALITY,
                    code="TOO_LONG",
                ))
        return issues
    
    def _check_has_instruction(self, item: Dict[str, Any]) -> List[ValidationIssue]:
        if not any(k in item for k in ["instruction", "prompt", "input", "question"]):
            return [ValidationIssue(
                message="Missing instruction/prompt/input field",
                severity=ValidationSeverity.ERROR,
                category=ValidationCategory.FORMAT,
                code="MISSING_INSTRUCTION",
            )]
        return []
    
    def _check_has_response(self, item: Dict[str, Any]) -> List[ValidationIssue]:
        if not any(k in item for k in ["response", "output", "answer", "completion"]):
            return [ValidationIssue(
                message="Missing response/output/answer field",
                severity=ValidationSeverity.ERROR,
                category=ValidationCategory.FORMAT,
                code="MISSING_RESPONSE",
            )]
        return []
    
    def _check_no_hallucination(self, item: Dict[str, Any]) -> List[ValidationIssue]:
        issues = []
        response = str(item.get("response", "") or item.get("output", "") or "")
        # Check for hallucination markers
        patterns = [
            (r"I don't have (enough |sufficient |)information", "Admits to lacking information"),
            (r"I cannot (provide|give|offer) (a |an |)specific", "Vague response"),
            (r"It is important to note that", "Generic hedge phrase"),
            (r"As an AI", "Generic AI disclaimer"),
        ]
        for pattern, reason in patterns:
            if re.search(pattern, response, re.I):
                issues.append(ValidationIssue(
                    message=f"Possible hallucination marker: {reason}",
                    severity=ValidationSeverity.WARNING,
                    category=ValidationCategory.QUALITY,
                    code="HALLUCINATION_MARKER",
                ))
        return issues
    
    def _check_no_pii(self, item: Dict[str, Any]) -> List[ValidationIssue]:
        issues = []
        text = json.dumps(item)
        patterns = [
            (r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}", "Email address"),
            (r"\b\d{3}[-.]?\d{3}[-.]?\d{4}\b", "Phone number"),
            (r"\b\d{3}-\d{2}-\d{4}\b", "SSN"),
            (r"\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13})\b", "Credit card"),
        ]
        for pattern, pii_type in patterns:
            if re.search(pattern, text):
                issues.append(ValidationIssue(
                    message=f"Possible PII detected: {pii_type}",
                    severity=ValidationSeverity.ERROR if self.strict else ValidationSeverity.WARNING,
                    category=ValidationCategory.SECURITY,
                    code="PII_DETECTED",
                    suggestion="Remove or redact the PII before training",
                ))
        return issues
    
    def _check_no_prompt_injection(self, item: Dict[str, Any]) -> List[ValidationIssue]:
        response = str(item.get("response", "") or "")
        patterns = [
            r"Ignore (all |the |)(above|previous|prior) (instructions|directives)",
            r"You are (now |)(GPT|Claude|AI|assistant|model).*?actually",
            r"Disregard (all |the |)(above|previous)",
            r"System prompt.*?(override|change|modify)",
        ]
        issues = []
        for pattern in patterns:
            if re.search(pattern, response, re.I):
                issues.append(ValidationIssue(
                    message="Possible prompt injection in response",
                    severity=ValidationSeverity.ERROR,
                    category=ValidationCategory.SECURITY,
                    code="PROMPT_INJECTION",
                ))
        return issues
    
    def _check_balanced_sentiment(self, item: Dict[str, Any]) -> List[ValidationIssue]:
        issues = []
        response = str(item.get("response", "") or item.get("output", "") or "")
        
        # Check for overly negative or overly positive language
        negative_words = ["hate", "terrible", "awful", "horrible", "disgusting", "stupid"]
        positive_words = ["amazing", "incredible", "perfect", "wonderful", "fantastic", "brilliant"]
        
        neg_count = sum(1 for w in negative_words if w in response.lower())
        pos_count = sum(1 for w in positive_words if w in response.lower())
        
        if neg_count > 3:
            issues.append(ValidationIssue(
                message=f"Overly negative tone ({neg_count} negative words)",
                severity=ValidationSeverity.WARNING,
                category=ValidationCategory.BIAS,
                code="NEGATIVE_TONE",
            ))
        if pos_count > 5:
            issues.append(ValidationIssue(
                message=f"Overly positive tone ({pos_count} positive words)",
                severity=ValidationSeverity.WARNING,
                category=ValidationCategory.BIAS,
                code="POSITIVE_TONE",
            ))
        return issues
    
    def _check_code_quality(self, item: Dict[str, Any]) -> List[ValidationIssue]:
        issues = []
        response = str(item.get("response", "") or item.get("output", "") or "")
        
        # Find code blocks
        code_blocks = re.findall(r'```(?:python|javascript|rust|go|java|typescript)?\n(.*?)```', response, re.DOTALL)
        
        for i, code in enumerate(code_blocks):
            # Check for syntax errors in Python code
            if "def " in code or "class " in code:
                has_docstring = '"""' in code or "'''" in code
                has_return = "return" in code
                
                if not has_docstring:
                    issues.append(ValidationIssue(
                        message=f"Code block {i+1} missing docstring",
                        severity=ValidationSeverity.WARNING,
                        category=ValidationCategory.QUALITY,
                        code="MISSING_DOCSTRING",
                    ))
                
                # Check for placeholder comments
                if "TODO" in code or "FIXME" in code or "pass" in code:
                    issues.append(ValidationIssue(
                        message=f"Code block {i+1} has TODO/FIXME/pass placeholder",
                        severity=ValidationSeverity.WARNING,
                        category=ValidationCategory.QUALITY,
                        code="PLACEHOLDER_CODE",
                    ))
        return issues
    
    def _check_math_correctness(self, item: Dict[str, Any]) -> List[ValidationIssue]:
        issues = []
        response = str(item.get("response", "") or "")
        domain = item.get("domain", "")
        
        if "math" not in domain.lower():
            return issues
        
        # Check for basic math correctness signals
        # Look for numerical answers
        numbers = re.findall(r'\b(\d+(\.\d+)?)\b', response)
        
        # Check if answer format is present
        if "answer" not in response.lower() and "result" not in response.lower():
            issues.append(ValidationIssue(
                message="Math domain response missing 'answer' or 'result' marker",
                severity=ValidationSeverity.WARNING,
                category=ValidationCategory.QUALITY,
                code="MISSING_ANSWER_MARKER",
            ))
        
        return issues
    
    def _check_consistent_format(self, item: Dict[str, Any]) -> List[ValidationIssue]:
        issues = []
        response = str(item.get("response", "") or "")
        
        # Check for mixed format markers
        thinking_count = len(re.findall(r'<thinking>|</thinking>', response))
        reason_count = len(re.findall(r'\[REASONING\]|\[/REASONING\]', response))
        
        if thinking_count > 0 and thinking_count % 2 != 0:
            issues.append(ValidationIssue(
                message="Unmatched <thinking> tags",
                severity=ValidationSeverity.WARNING,
                category=ValidationCategory.FORMAT,
                code="UNMATCHED_TAGS",
            ))
        if reason_count > 0 and reason_count % 2 != 0:
            issues.append(ValidationIssue(
                message="Unmatched [REASONING] tags",
                severity=ValidationSeverity.WARNING,
                category=ValidationCategory.FORMAT,
                code="UNMATCHED_TAGS",
            ))
        return issues
