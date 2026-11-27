# The move load test: one image, the page and the runner on :8795.
# Build context is THIS folder:
#   docker build -t serversherpa-loadtest loadtest
# Results live in /data (a volume); nothing else is written.
FROM python:3.13-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY pyproject.toml ./
COPY src ./src
COPY profiles ./profiles
# Editable on purpose: the tool finds profiles/ next to src/.
RUN pip install --no-cache-dir -e . \
 && useradd --system --uid 10001 --no-create-home loadtest \
 && mkdir /data && chown 10001:10001 /data
USER 10001
VOLUME /data
EXPOSE 8795
# Any answer means the page is up; unsigned, the answer is the sign-in page.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD python -c "import sys, urllib.request, urllib.error; exec('try: urllib.request.urlopen(\"http://127.0.0.1:8795/\", timeout=4)\nexcept urllib.error.HTTPError: pass')"
ENTRYPOINT ["python", "-m", "loadtest"]
CMD ["--runs-dir", "/data/runs"]
