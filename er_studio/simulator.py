import subprocess
import threading
import logging

from PySide6.QtCore import QObject, Signal

logger = logging.getLogger("er-studio")

class Simulator(QObject):

    log_signal = Signal(str, str)
    status_signal = Signal(bool)

    def __init__(self, automation_port=9898):

        super().__init__()
        
        self.automation_port = automation_port
        self.process = None
        self.is_running = False

    def start(self):
        cmd = ["npx", "@evenrealities/evenhub-simulator", "--automation-port", str(self.automation_port)]
        
        # start the simulator
        try:
            self.log_signal.emit("INFO", f"Starting simulator: {' '.join(cmd)}") # log for debug

            self.process = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                bufsize=1
            )

            self.is_running = True
            self.status_signal.emit(True)

            # separate threads to read stdout and stderr without blocking the ui
            threading.Thread(target=self._read_pipe, args=(self.process.stdout, "INFO"), daemon=True).start()
            threading.Thread(target=self._read_pipe, args=(self.process.stderr, "WARN"), daemon=True).start()

        except Exception as e:
            self.log_signal.emit("ERROR", f"Unable to start the simulator: {str(e)}")
            self.is_running = False
            self.status_signal.emit(False)

    def _read_pipe(self, pipe, default_level):
        for line in iter(pipe.readline, ''):
            if line:
                clean_line = line.strip()
                level = default_level
                if "error" in clean_line.lower():
                    level = "ERROR"
                elif "warn" in clean_line.lower():
                    level = "WARN"
                self.log_signal.emit(level, clean_line)
        pipe.close()

    def stop(self):
        # if the window is closed terminate the program
        if self.process:
            self.log_signal.emit("INFO", "Closing the simulator...")
            self.process.terminate()
            try:
                self.process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self.process.kill()
            self.is_running = False
            self.status_signal.emit(False)