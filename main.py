import sys
import logging
from PySide6.QtWidgets import QApplication
from er_studio.gui.main_window import MainWindow
from er_studio.environment import EnvironmentManager

def main():

    logging.basicConfig(level=logging.INFO)
    app = QApplication(sys.argv)
    app.setStyle("Fusion")

    if not EnvironmentManager.check_node():
        print("[ER-STUDIO WARNING] Node.js wasn't found on your system. Please check the installation and restart the simulator.")

    window = MainWindow()
    window.show()
    sys.exit(app.exec())

if __name__ == "__main__":
    main()