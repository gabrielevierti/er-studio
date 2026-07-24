import shutil
import logging

logger = logging.getLogger("er-studio")

class EnvironmentManager:

    @staticmethod
    def check_node() -> bool:
        
        """verify if node.js and npm are in PATH"""
        has_node = shutil.which("node") is not None
        has_npm = shutil.which("npm") is not None

        return has_node and has_npm