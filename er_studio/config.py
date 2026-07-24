import os
from pathlib import Path

APP_NAME = "er-studio"
APP_VERSION = "0.1.0"

# network ports
AUTOMATION_PORT = 9898
SIMULATOR_PORT = 3000

# where to save logs
USER_DIR = Path.home() / ".er_studio"
LOGS_DIR = USER_DIR / "logs"

USER_DIR.mkdir(parents=True, exist_ok=True)
LOGS_DIR.mkdir(parents=True, exist_ok=True)

# g1 & g2 screen dimensions
GLASSES_WIDTH = 576
GLASSES_HEIGHT = 288