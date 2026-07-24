from setuptools import setup, find_packages

setup(
    name="er-studio",
    version="0.1.0",
    author="Il Tuo Nome / Community",
    description="All-In-One Developer Dashboard per Even Realities Smart Glasses SDK",
    packages=find_packages(),
    install_requires=[
        "PySide6>=6.5.0",
        "PySide6-WebEngine>=6.5.0",
        "requests>=2.28.0",
    ],
    entry_points={
        "console_scripts": [
            "er-studio = main:main",
        ],
    },
)