"""Real-time pipeline monitoring, metrics, and alerting.

Provides progress tracking, stage-level metrics collection,
threshold-based alerting, and structured data for dashboards.

Classes
-------
StageMetrics: Per-stage timing, memory, and throughput metrics.
AlertManager: Threshold-based alert evaluation and dispatch.
DashboardData: Structured data for web display.
PipelineMonitor: Orchestrates monitoring, metrics, and alerts.
"""

from __future__ import annotations

import enum
import json
import logging
import math
import threading
import time
from collections import defaultdict, deque
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Set, Tuple

from lazy_chameleon.pipeline.core import PipelineStage, PipelineResult, StageStatus

logger = logging.getLogger(__name__)


class MetricType(enum.Enum):
    """Types of metrics collected during pipeline execution.
    Attributes
    ----------
    DURATION: Wall-clock execution time.
    CPU_USAGE: CPU utilization percentage.
    MEMORY_USAGE: Memory usage in MB.
    THROUGHPUT: Items processed per second.
    LATENCY: Per-item latency in seconds.
    ERROR_RATE: Fraction of items with errors.
    DISK_IO: Disk read/write in MB/s.
    NETWORK_IO: Network transfer in MB/s.
    CUSTOM: User-defined metric.
    """
    DURATION = "duration"
    CPU_USAGE = "cpu_usage"
    MEMORY_USAGE = "memory_usage"
    THROUGHPUT = "throughput"
    LATENCY = "latency"
    ERROR_RATE = "error_rate"
    DISK_IO = "disk_io"
    NETWORK_IO = "network_io"
    CUSTOM = "custom"


class AlertSeverity(enum.Enum):
    """Severity levels for pipeline alerts.
    Attributes
    ----------
    INFO: Informational notification.
    WARNING: Potential issue that should be reviewed.
    ERROR: Serious issue that may affect results.
    CRITICAL: Pipeline-stopping condition.
    """
    INFO = "info"
    WARNING = "warning"
    ERROR = "error"
    CRITICAL = "critical"

@dataclass
class StageMetrics:
    """Collects and computes per-stage performance metrics.
    Tracks timing, memory usage, throughput, latency, and error rates.
    Parameters
    ----------
    stage_name: Name of the stage being monitored.
    window_size: Number of recent data points for rolling stats.
    """
    stage_name: str
    window_size: int = 100
    _start_time: float = 0.0
    _end_time: float = 0.0
    _item_count: int = 0
    _error_count: int = 0
    _durations: deque = field(default_factory=lambda: deque(maxlen=100))
    _memory_samples: deque = field(default_factory=lambda: deque(maxlen=100))
    _throughput_samples: deque = field(default_factory=lambda: deque(maxlen=100))
    _latency_samples: deque = field(default_factory=lambda: deque(maxlen=100))
    _custom_metrics: Dict[str, deque] = field(default_factory=dict)
    _lock: Any = field(default_factory=threading.RLock)

    def start_timer(self):
        """Start the execution timer.
        """
        self._start_time = time.time()

    def stop_timer(self):
        """Stop the execution timer and record duration.
        Returns
        -------
        float: Recorded duration in seconds.
        """
        self._end_time = time.time()
        duration = self._end_time - self._start_time
        with self._lock:
            self._durations.append(duration)
        return duration

    @property
    def duration(self) -> float:
        """Return total wall-clock duration in seconds."""
        if self._start_time == 0.0:
            return 0.0
        end = self._end_time or time.time()
        return end - self._start_time

    def record_item(self, count=1):
        """Record successful item processing.
        Parameters
        ----------
        count: Number of items processed.
        """
        with self._lock:
            self._item_count += count

    def record_error(self, count=1):
        """Record processing errors.
        Parameters
        ----------
        count: Number of errors.
        """
        with self._lock:
            self._error_count += count

    def record_throughput(self, items_per_second):
        """Record a throughput measurement.
        Parameters
        ----------
        items_per_second: Measured throughput value.
        """
        with self._lock:
            self._throughput_samples.append(items_per_second)

    def record_latency(self, seconds):
        """Record a per-item latency measurement.
        Parameters
        ----------
        seconds: Latency in seconds.
        """
        with self._lock:
            self._latency_samples.append(seconds)

    def record_memory(self, mb):
        """Record a memory usage sample.
        Parameters
        ----------
        mb: Memory usage in MB.
        """
        with self._lock:
            self._memory_samples.append(mb)

    def record_custom(self, name, value):
        """Record a custom metric value.
        Parameters
        ----------
        name: Metric name.
        value: Numeric value.
        """
        with self._lock:
            if name not in self._custom_metrics:
                self._custom_metrics[name] = deque(maxlen=self.window_size)
            self._custom_metrics[name].append(value)

    @property
    def item_count(self) -> int:
        return self._item_count

    @property
    def error_count(self) -> int:
        return self._error_count

    @property
    def error_rate(self) -> float:
        total = self._item_count + self._error_count
        if total == 0:
            return 0.0
        return self._error_count / total

    @property
    def throughput(self) -> float:
        if not self._throughput_samples:
            return 0.0
        return sum(self._throughput_samples) / len(self._throughput_samples)

    @property
    def avg_latency(self) -> float:
        if not self._latency_samples:
            return 0.0
        return sum(self._latency_samples) / len(self._latency_samples)

    @property
    def avg_memory_mb(self) -> float:
        if not self._memory_samples:
            return 0.0
        return sum(self._memory_samples) / len(self._memory_samples)

    @property
    def peak_memory_mb(self) -> float:
        if not self._memory_samples:
            return 0.0
        return max(self._memory_samples)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "stage_name": self.stage_name,
            "duration_seconds": self.duration,
            "item_count": self._item_count,
            "error_count": self._error_count,
            "error_rate": self.error_rate,
            "avg_throughput": self.throughput,
            "avg_latency_seconds": self.avg_latency,
            "avg_memory_mb": self.avg_memory_mb,
            "peak_memory_mb": self.peak_memory_mb,
        }

    def reset(self):
        """Reset all metrics to initial state.
        """
        self._start_time = 0.0
        self._end_time = 0.0
        self._item_count = 0
        self._error_count = 0
        self._durations.clear()
        self._memory_samples.clear()
        self._throughput_samples.clear()
        self._latency_samples.clear()
        self._custom_metrics.clear()


@dataclass
class AlertRule:
    """Defines an alert threshold rule.
    Parameters
    ----------
    metric_name: Name of the metric to monitor.
    operator: Comparison operator (gt, lt, gte, lte, eq).
    threshold: Value to compare against.
    severity: Alert severity on breach.
    message: Alert message template.
    """
    metric_name: str
    operator: str = "gt"
    threshold: float = 0.0
    severity: AlertSeverity = AlertSeverity.WARNING
    message: str = "Metric {metric} = {value} exceeded threshold {op} {threshold}"
    _breach_count: int = 0

    def evaluate(self, value: float) -> Optional["Alert"]:
        """Evaluate a metric value against this rule.
        Parameters
        ----------
        value: Current metric value.
        Returns
        -------
        Optional[Alert]: Alert if breached, else None.
        """
        breached = False
        if self.operator == "gt" and value > self.threshold:
            breached = True
        elif self.operator == "lt" and value < self.threshold:
            breached = True
        elif self.operator == "gte" and value >= self.threshold:
            breached = True
        elif self.operator == "lte" and value <= self.threshold:
            breached = True
        elif self.operator == "eq" and value == self.threshold:
            breached = True
        if breached:
            self._breach_count += 1
            msg = self.message.format(metric=self.metric_name, value=value, op=self.operator, threshold=self.threshold)
            return Alert(metric=self.metric_name, value=value, rule=self, message=msg, severity=self.severity)
        return None


@dataclass
class Alert:
    """Represents a triggered alert.
    Parameters
    ----------
    metric: Name of the metric.
    value: Current value.
    rule: The rule that triggered.
    message: Human-readable message.
    severity: Alert severity.
    timestamp: Unix timestamp when triggered.
    """
    metric: str
    value: float
    rule: AlertRule
    message: str
    severity: AlertSeverity
    timestamp: float = field(default_factory=time.time)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "metric": self.metric,
            "value": self.value,
            "message": self.message,
            "severity": self.severity.value,
            "timestamp": self.timestamp,
        }


class AlertManager:
    """Manages alert rules, evaluation, and dispatch.
    Parameters
    ----------
    handlers: Optional list of callables to invoke on alert.
    max_alerts: Maximum number of alerts to retain.
    """
    def __init__(self, handlers: Optional[List[Callable]] = None, max_alerts: int = 1000):
        self._rules: Dict[str, List[AlertRule]] = defaultdict(list)
        self._alerts: deque = deque(maxlen=max_alerts)
        self._handlers: List[Callable] = list(handlers or [])
        self._lock = threading.RLock()
        self._logger = logging.getLogger(f"{__name__}.AlertManager")

    def add_rule(self, rule: AlertRule, stage_name: Optional[str] = None):
        """Add an alert rule.
        Parameters
        ----------
        rule: AlertRule instance.
        stage_name: Optional stage scope (None = global).
        """
        key = stage_name or "*global*"
        self._rules[key].append(rule)
        self._logger.debug("Added rule %s for stage %s", rule.metric_name, key)

    def evaluate(self, stage_name: str, metrics: Dict[str, float]):
        """Evaluate all rules against current metrics.
        Parameters
        ----------
        stage_name: Name of the stage.
        metrics: Dict mapping metric names to values.
        """
        alerts = []
        for key in [stage_name, "*global*"]:
            for rule in self._rules.get(key, []):
                value = metrics.get(rule.metric_name)
                if value is not None:
                    alert = rule.evaluate(value)
                    if alert:
                        alerts.append(alert)
                        self._alerts.append(alert)
                        for handler in self._handlers:
                            try:
                                handler(alert)
                            except Exception as exc:
                                self._logger.error("Alert handler failed: %s", exc)
        return alerts

    def get_recent_alerts(self, n=10) -> List[Alert]:
        """Return the n most recent alerts.
        """
        with self._lock:
            return list(self._alerts)[-n:]

    def get_alerts_by_severity(self, severity: AlertSeverity) -> List[Alert]:
        """Return all alerts of a given severity.
        """
        with self._lock:
            return [a for a in self._alerts if a.severity == severity]

    def clear(self):
        """Clear all stored alerts.
        """
        with self._lock:
            self._alerts.clear()

    @property
    def total_alerts(self) -> int:
        return len(self._alerts)


@dataclass
class DashboardData:
    """Structured data for web dashboard display.
    Aggregates pipeline status, stage metrics, alerts, and progress
    into a format suitable for JSON serialization and UI rendering.
    """
    pipeline_name: str = ""
    pipeline_status: str = "pending"
    progress_percent: float = 0.0
    stages_completed: int = 0
    stages_total: int = 0
    duration_seconds: float = 0.0
    stage_metrics: Dict[str, Dict[str, Any]] = field(default_factory=dict)
    alerts: List[Dict[str, Any]] = field(default_factory=list)
    resource_usage: Dict[str, float] = field(default_factory=dict)
    run_id: str = ""
    timestamp: float = field(default_factory=time.time)

    def to_json(self) -> str:
        """Serialize to JSON string.
        Returns
        -------
        str: JSON representation.
        """
        return json.dumps(self.to_dict())

    def to_dict(self) -> Dict[str, Any]:
        """Convert to plain dict for serialization.
        Returns
        -------
        Dict[str, Any]: Dict representation.
        """
        return {
            "pipeline_name": self.pipeline_name,
            "pipeline_status": self.pipeline_status,
            "progress_percent": self.progress_percent,
            "stages_completed": self.stages_completed,
            "stages_total": self.stages_total,
            "duration_seconds": self.duration_seconds,
            "stage_metrics": self.stage_metrics,
            "alerts": self.alerts,
            "resource_usage": self.resource_usage,
            "run_id": self.run_id,
            "timestamp": self.timestamp,
        }

    @classmethod
    def from_monitor(cls, monitor: "PipelineMonitor") -> "DashboardData":
        """Create DashboardData snapshot from a PipelineMonitor.
        Parameters
        ----------
        monitor: The PipelineMonitor instance.
        Returns
        -------
        DashboardData: Populated dashboard data.
        """
        stage_metrics = {}
        for name, metrics in monitor._metrics.items():
            stage_metrics[name] = metrics.to_dict()
        data = cls(
            pipeline_name=monitor.pipeline_name,
            pipeline_status=monitor.status.value if hasattr(monitor.status, "value") else str(monitor.status),
            progress_percent=monitor.progress_percent,
            stages_completed=monitor.completed_stages,
            stages_total=monitor.total_stages,
            duration_seconds=monitor.elapsed_seconds,
            stage_metrics=stage_metrics,
            alerts=[a.to_dict() for a in monitor.alert_manager.get_recent_alerts(20)],
            resource_usage=monitor.resource_usage,
            run_id=monitor.run_id,
        )
        return data

class PipelineMonitor:
    """Orchestrates real-time monitoring, metrics collection, and alerting.
    Tracks pipeline progress, per-stage metrics, resource usage, and alerts.
    Parameters
    ----------
    pipeline_name: Name of the pipeline being monitored.
    alert_manager: Optional AlertManager instance.
    metrics_window: Window size for rolling metric samples.
    """
    def __init__(self, pipeline_name="pipeline", alert_manager=None, metrics_window=100):
        self.pipeline_name = pipeline_name
        self.alert_manager = alert_manager or AlertManager()
        self._metrics: Dict[str, StageMetrics] = {}
        self._status: StageStatus = StageStatus.PENDING
        self._start_time: float = 0.0
        self._end_time: float = 0.0
        self._total_stages: int = 0
        self._completed_stages: int = 0
        self._failed_stages: int = 0
        self._skipped_stages: int = 0
        self._current_stage: Optional[str] = None
        self._stage_order: List[str] = []
        self._resource_usage: Dict[str, float] = {}
        self._run_id: str = f"run_{int(time.time() * 1000)}"
        self._lock = threading.RLock()
        self._logger = logging.getLogger(f"{__name__}.PipelineMonitor")
        self._callbacks: Dict[str, List[Callable]] = defaultdict(list)

    def register_stages(self, stage_names):
        """Register stages to monitor.
        Parameters
        ----------
        stage_names: List of stage name strings.
        """
        self._total_stages = len(stage_names)
        self._stage_order = list(stage_names)
        for name in stage_names:
            if name not in self._metrics:
                self._metrics[name] = StageMetrics(stage_name=name, window_size=self.alert_manager._rules.__len__() if hasattr(self.alert_manager, "_rules") else 100)
        self._logger.info("Registered %d stages for monitoring", len(stage_names))

    def start_run(self):
        """Mark the beginning of a pipeline run.
        """
        self._start_time = time.time()
        self._status = StageStatus.RUNNING
        self._trigger_callbacks("run_start", {})

    def end_run(self, status):
        """Mark the end of a pipeline run.
        Parameters
        ----------
        status: Final StageStatus.
        """
        self._end_time = time.time()
        self._status = status
        self._trigger_callbacks("run_end", {"status": status.value})

    def start_stage(self, stage_name):
        """Mark the start of a stage.
        Parameters
        ----------
        stage_name: Name of the stage.
        """
        self._current_stage = stage_name
        metrics = self._metrics.get(stage_name)
        if metrics:
            metrics.start_timer()
        self._trigger_callbacks("stage_start", {"stage": stage_name})

    def end_stage(self, stage_name, status, metrics_update=None):
        """Mark the end of a stage and update metrics.
        Parameters
        ----------
        stage_name: Name of the stage.
        status: StageStatus of the completed stage.
        metrics_update: Optional dict of metric values to record.
        """
        metrics = self._metrics.get(stage_name)
        if metrics:
            metrics.stop_timer()
            if metrics_update:
                if "items" in metrics_update:
                    metrics.record_item(metrics_update["items"])
                if "errors" in metrics_update:
                    metrics.record_error(metrics_update["errors"])
                if "throughput" in metrics_update:
                    metrics.record_throughput(metrics_update["throughput"])
                if "latency" in metrics_update:
                    metrics.record_latency(metrics_update["latency"])
                if "memory_mb" in metrics_update:
                    metrics.record_memory(metrics_update["memory_mb"])
        with self._lock:
            if status == StageStatus.SUCCESS:
                self._completed_stages += 1
            elif status == StageStatus.FAILED:
                self._failed_stages += 1
            elif status == StageStatus.SKIPPED:
                self._skipped_stages += 1
        # Evaluate alert rules
        if metrics:
            self.alert_manager.evaluate(stage_name, metrics.to_dict())
        self._current_stage = None
        self._trigger_callbacks("stage_end", {"stage": stage_name, "status": status.value})

    def update_resource_usage(self, usage):
        """Update resource usage snapshot.
        Parameters
        ----------
        usage: Dict of resource name -> value.
        """
        with self._lock:
            self._resource_usage.update(usage)

    def on(self, event, callback):
        """Register a callback for a monitoring event.
        Events: run_start, run_end, stage_start, stage_end.
        Parameters
        ----------
        event: Event name string.
        callback: Callable accepting a dict payload.
        """
        self._callbacks[event].append(callback)

    def _trigger_callbacks(self, event, payload):
        for cb in self._callbacks.get(event, []):
            try:
                cb(payload)
            except Exception as exc:
                self._logger.error("Callback %s failed: %s", event, exc)

    @property
    def status(self):
        return self._status

    @property
    def progress_percent(self) -> float:
        if self._total_stages == 0:
            return 0.0
        done = self._completed_stages + self._failed_stages + self._skipped_stages
        return min(100.0, done / self._total_stages * 100.0)

    @property
    def completed_stages(self) -> int:
        return self._completed_stages

    @property
    def total_stages(self) -> int:
        return self._total_stages

    @property
    def failed_stages(self) -> int:
        return self._failed_stages

    @property
    def elapsed_seconds(self) -> float:
        if self._start_time == 0.0:
            return 0.0
        end = self._end_time or time.time()
        return end - self._start_time

    @property
    def run_id(self) -> str:
        return self._run_id

    @property
    def resource_usage(self) -> Dict[str, float]:
        with self._lock:
            return dict(self._resource_usage)

    def get_stage_metrics(self, stage_name) -> Optional[StageMetrics]:
        return self._metrics.get(stage_name)

    def get_dashboard_data(self) -> DashboardData:
        return DashboardData.from_monitor(self)

    def snapshot(self) -> Dict[str, Any]:
        return {
            "pipeline_name": self.pipeline_name,
            "status": self._status.value if hasattr(self._status, "value") else str(self._status),
            "progress_percent": self.progress_percent,
            "completed_stages": self._completed_stages,
            "total_stages": self._total_stages,
            "failed_stages": self._failed_stages,
            "elapsed_seconds": self.elapsed_seconds,
            "current_stage": self._current_stage,
            "run_id": self._run_id,
            "resource_usage": self.resource_usage,
        }

    def reset(self):
        """Reset monitor state for a new run.
        """
        self._status = StageStatus.PENDING
        self._start_time = 0.0
        self._end_time = 0.0
        self._completed_stages = 0
        self._failed_stages = 0
        self._skipped_stages = 0
        self._current_stage = None
        self._resource_usage.clear()
        for m in self._metrics.values():
            m.reset()
        self.alert_manager.clear()
        self._run_id = f"run_{int(time.time() * 1000)}"
