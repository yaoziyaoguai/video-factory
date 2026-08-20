from setuptools import find_packages, setup


setup(
    name="video-factory",
    version="0.1.0",
    description="Local-first short video production workflow MVP.",
    package_dir={"": "src"},
    packages=find_packages("src"),
    python_requires=">=3.9",
    install_requires=[
        "Pillow>=10.0",
    ],
    entry_points={
        "console_scripts": [
            "video-factory=video_factory.cli:main",
        ],
    },
)
