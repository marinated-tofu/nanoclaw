# syntax=docker/dockerfile:1
# Local speech to text for the web page: faster-whisper behind a tiny HTTP server.
# The CUDA libraries come from pip; the driver comes from the host (see run.sh).
FROM python:3.12-slim
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install "faster-whisper>=1.1,<2" nvidia-cublas-cu12 "nvidia-cudnn-cu12>=9,<10"
ENV NVIDIA_LIBS=/usr/local/lib/python3.12/site-packages/nvidia
ENV LD_LIBRARY_PATH=/usr/lib/wsl/lib:${NVIDIA_LIBS}/cublas/lib:${NVIDIA_LIBS}/cudnn/lib \
    HF_HOME=/models \
    PYTHONUNBUFFERED=1
RUN useradd --system --create-home stt && mkdir /models && chown stt /models
USER stt
COPY server.py /app/server.py
EXPOSE 8178
CMD ["python", "/app/server.py"]
