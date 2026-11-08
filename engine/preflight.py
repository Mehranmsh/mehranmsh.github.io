#!/usr/bin/env python3
"""Offline hardware and resource inventory for the MEHRAN local audio runtime."""
from __future__ import annotations

import json
import importlib.util
import os
import platform
import shutil
import subprocess
from pathlib import Path

ROOT = Path(os.environ.get("MEHRAN_STUDIO_HOME", Path.home() / ".mehran-music-studio")).expanduser()


def total_memory_bytes():
    meminfo = Path("/proc/meminfo")
    if meminfo.exists():
        for line in meminfo.read_text(encoding="utf-8").splitlines():
            if line.startswith("MemTotal:"):
                return int(line.split()[1]) * 1024
    if hasattr(os, "sysconf"):
        try:
            return os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES")
        except (ValueError, OSError):
            pass
    return None


def command_output(command):
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=4, check=False)
        if result.returncode == 0:
            return result.stdout.strip()
    except (OSError, subprocess.TimeoutExpired):
        pass
    return ""


def detect_gpu():
    nvidia = command_output(["nvidia-smi", "--query-gpu=name,memory.total,memory.free", "--format=csv,noheader"])
    if nvidia:
        return {"detected": True, "vendor": "NVIDIA", "details": nvidia.splitlines(), "source": "nvidia-smi"}
    amd = command_output(["rocm-smi", "--showproductname"])
    if amd:
        return {"detected": True, "vendor": "AMD", "details": amd.splitlines()[:8], "source": "rocm-smi"}
    if platform.system() == "Darwin":
        apple = command_output(["system_profiler", "SPDisplaysDataType"])
        if apple:
            lines = [line.strip() for line in apple.splitlines() if "Chipset Model:" in line or "Total Number of Cores:" in line]
            if lines:
                return {"detected": True, "vendor": "Apple", "details": lines, "source": "system_profiler"}
    return {"detected": False, "vendor": None, "details": [], "source": None}


def inspect():
    disk_path = ROOT
    while not disk_path.exists() and disk_path != disk_path.parent:
        disk_path = disk_path.parent
    disk = shutil.disk_usage(disk_path)
    memory = total_memory_bytes()
    try:
        torch_available = importlib.util.find_spec("torch") is not None
    except (ImportError, ValueError):
        torch_available = False
    return {
        "system": {
            "os": platform.platform(),
            "architecture": platform.machine(),
            "python": platform.python_version(),
            "cpu_cores": os.cpu_count(),
            "ram_total_bytes": memory,
            "pytorch_installed": torch_available,
        },
        "gpu": detect_gpu(),
        "storage": {
            "studio_data_path": str(ROOT),
            "checked_existing_mount": str(disk_path),
            "total_bytes": disk.total,
            "free_bytes": disk.free,
        },
        "network_accessed": False,
        "models_downloaded": False,
        "paid_services_used": False,
        "notice": "Read-only inventory. No directory is created, no network is accessed, no model is downloaded, no audio is generated, and no paid service is contacted.",
    }


if __name__ == "__main__":
    print(json.dumps(inspect(), ensure_ascii=False, indent=2))
