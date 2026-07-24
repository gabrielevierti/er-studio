import time
import requests
from PySide6.QtCore import Qt, QTimer
from PySide6.QtWidgets import (
    QMainWindow, QWidget, QHBoxLayout, QVBoxLayout, QSplitter,
    QTextEdit, QLabel, QPushButton, QComboBox, QFrame, QStackedWidget, QStatusBar
)
from PySide6.QtGui import QImage, QPixmap, QFont
from PySide6.QtWebEngineWidgets import QWebEngineView

from er_studio.config import APP_NAME, APP_VERSION, GLASSES_WIDTH, GLASSES_HEIGHT, AUTOMATION_PORT
from er_studio.simulator import Simulator

class CameraWidget(QWidget):
    # todo: simulated, please implement
    def __init__(self, parent=None):
        super().__init__(parent)
        self.setStyleSheet("background-color: #1a1a24;")
        layout = QVBoxLayout(self)
        label = QLabel("AR Background (Camera Feed Mock)", self)
        label.setAlignment(Qt.AlignCenter)
        label.setStyleSheet("color: #8a8a9e; font-size: 13px; font-weight: bold;")
        layout.addWidget(label)

class GlassesDisplayView(QFrame):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.setFrameShape(QFrame.StyledPanel)
        self.setStyleSheet("background-color: #0f0f15; border-radius: 8px;")

        main_layout = QVBoxLayout(self)
        
        # Header / Controls
        controls_layout = QHBoxLayout()
        title_label = QLabel("<b>Glasses Display (576x288)</b>")
        title_label.setStyleSheet("color: #e1e1e6;")
        
        bg_label = QLabel("Background:")
        bg_label.setStyleSheet("color: #a0a0b0;")
        
        self.bg_combo = QComboBox()
        self.bg_combo.addItems(["Color", "Camera"])
        self.bg_combo.setStyleSheet("""
            QComboBox { background-color: #20202d; color: #fff; border: 1px solid #3a3a4c; padding: 4px; border-radius: 4px; }
            QComboBox QAbstractItemView { background-color: #20202d; color: #fff; selection-background-color: #4a4a68; }
        """)
        self.bg_combo.currentIndexChanged.connect(self._change_bg)

        controls_layout.addWidget(title_label)
        controls_layout.addStretch()
        controls_layout.addWidget(bg_label)
        controls_layout.addWidget(self.bg_combo)
        main_layout.addLayout(controls_layout)

        # Container screen
        self.screen_container = QWidget()
        self.screen_container.setFixedSize(GLASSES_WIDTH, GLASSES_HEIGHT)
        self.screen_container.setStyleSheet("border: 2px solid #00ff88; border-radius: 4px; background-color: #000000;")
        
        container_layout = QVBoxLayout(self.screen_container)
        container_layout.setContentsMargins(0, 0, 0, 0)

        # Black | Camera
        self.stack = QStackedWidget(self.screen_container)
        self.black_bg = QWidget()
        self.black_bg.setStyleSheet("background-color: #000000;")
        self.camera_bg = CameraWidget()

        self.stack.addWidget(self.black_bg)
        self.stack.addWidget(self.camera_bg)
        
        # Display Pixmap Overlay
        self.display_label = QLabel(self.screen_container)
        self.display_label.setFixedSize(GLASSES_WIDTH, GLASSES_HEIGHT)
        self.display_label.setAlignment(Qt.AlignCenter)
        self.display_label.setStyleSheet("background: transparent;")
        
        container_layout.addWidget(self.stack)
        self.display_label.raise_()

        main_layout.addWidget(self.screen_container, alignment=Qt.AlignCenter)

        # Input buttons
        touch_layout = QHBoxLayout()
        btn_touch_click = QPushButton("Click")
        btn_touch_up = QPushButton("Up")
        btn_touch_down = QPushButton("Down") #todo: implement all inputs
        
        for btn in [btn_touch_click, btn_touch_up, btn_touch_down]:
            btn.setStyleSheet("""
                QPushButton { background-color: #282838; color: #00ff88; border: 1px solid #38384d; padding: 6px 12px; border-radius: 4px; font-weight: bold; }
                QPushButton:hover { background-color: #35354a; }
                QPushButton:pressed { background-color: #00ff88; color: #000; }
            """)
        
        btn_touch_click.clicked.connect(lambda: self.send_input("click"))
        btn_touch_up.clicked.connect(lambda: self.send_input("up"))
        btn_touch_down.clicked.connect(lambda: self.send_input("down"))

        touch_layout.addWidget(btn_touch_click)
        touch_layout.addWidget(btn_touch_up)
        touch_layout.addWidget(btn_touch_down)
        main_layout.addLayout(touch_layout)

    def _change_bg(self, index):
        self.stack.setCurrentIndex(index)

    def update_framebuffer(self, image_bytes):
        # update by getting the png from the sim
        image = QImage()
        if image.loadFromData(image_bytes):
            pixmap = QPixmap.fromImage(image)
            self.display_label.setPixmap(pixmap)

    def send_input(self, action):
        try:
            requests.post(f"http://localhost:{AUTOMATION_PORT}/api/input", json={"action": action}, timeout=0.5)
        except Exception:
            pass

class ConsoleLogWidget(QWidget):
    def __init__(self, parent=None):
        super().__init__(parent)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)

        header_layout = QHBoxLayout()
        header_label = QLabel("<b>Console & Output Logs</b>")
        header_label.setStyleSheet("color: #a0a0b0;")
        
        btn_clear = QPushButton("Clean")
        btn_clear.setStyleSheet("background-color: #20202d; color: #fff; border: 1px solid #3a3a4c; padding: 2px 8px; border-radius: 3px;")
        btn_clear.clicked.connect(lambda: self.text_area.clear())

        header_layout.addWidget(header_label)
        header_layout.addStretch()
        header_layout.addWidget(btn_clear)
        layout.addLayout(header_layout)

        self.text_area = QTextEdit()
        self.text_area.setReadOnly(True)
        self.text_area.setFont(QFont("Consolas", 10))
        self.text_area.setStyleSheet("background-color: #0d0d12; color: #d1d1e0; border: 1px solid #262636; border-radius: 6px; padding: 6px;")
        layout.addWidget(self.text_area)

    def append_log(self, level, message):
        color_map = {"INFO": "#00ff88", "WARN": "#ffb700", "ERROR": "#ff4d4d"}
        color = color_map.get(level, "#ffffff")
        timestamp = time.strftime("%H:%M:%S")
        formatted = f'<span style="color: #666680;">[{timestamp}]</span> <b style="color: {color};">[{level}]</b> {message}'
        self.text_area.append(formatted)

class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle(f"{APP_NAME} v{APP_VERSION} - Even Realities Studio")
        self.resize(1280, 800)
        self.setStyleSheet("background-color: #14141d; color: #ffffff;")

        self.runner = Simulator()
        self.runner.log_signal.connect(self.on_log_received)

        self._init_ui()

        self.screen_timer = QTimer()
        self.screen_timer.setInterval(100)
        self.screen_timer.timeout.connect(self._fetch_screen_frame)
        
        self.runner.start()
        self.screen_timer.start()

    def _init_ui(self):
        main_widget = QWidget()
        self.setCentralWidget(main_widget)
        main_layout = QVBoxLayout(main_widget)

        # Vertical Splitter
        vertical_splitter = QSplitter(Qt.Vertical)

        # Top Splitter
        top_splitter = QSplitter(Qt.Horizontal)

        # Web inspector
        self.web_view = QWebEngineView()
        self.web_view.setUrl("http://localhost:3000")

        # Glasses' display panel
        self.glasses_view = GlassesDisplayView()

        top_splitter.addWidget(self.web_view)
        top_splitter.addWidget(self.glasses_view)
        top_splitter.setSizes([700, 580])

        # Console panel
        self.console_widget = ConsoleLogWidget()

        vertical_splitter.addWidget(top_splitter)
        vertical_splitter.addWidget(self.console_widget)
        vertical_splitter.setSizes([550, 200])

        main_layout.addWidget(vertical_splitter)

        self.statusBar = QStatusBar()
        self.setStatusBar(self.statusBar)
        self.statusBar.showMessage("er-studio ready. sim live at localhost:9898")

    def on_log_received(self, level, message):
        self.console_widget.append_log(level, message)

    def _fetch_screen_frame(self):
        if not self.runner.is_running:
            return
        try:
            resp = requests.get(f"http://localhost:{AUTOMATION_PORT}/api/screenshot/glasses", timeout=0.1)
            if resp.status_code == 200:
                self.glasses_view.update_framebuffer(resp.content)
        except Exception:
            pass

    def closeEvent(self, event):
        self.screen_timer.stop()
        self.runner.stop()
        event.accept()