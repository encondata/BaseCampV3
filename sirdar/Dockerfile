# Sirdar — one image: the FastAPI app serves /api and the built SPA.
# Build context is the REPO ROOT (the SPA imports portal/src + portal/public):
#   docker build -f sirdar/Dockerfile -t sirdar .
FROM node:20-alpine AS web
WORKDIR /app
COPY sirdar/web/package.json sirdar/web/package-lock.json ./sirdar/web/
RUN npm ci --prefix sirdar/web
COPY portal/src ./portal/src
COPY portal/public ./portal/public
COPY sirdar/web ./sirdar/web
# Vite only: `npm run build` also type-checks, which needs portal/node_modules
# (not in this image); CI and local builds type-check, vite dedupes the rest.
RUN cd sirdar/web && npx vite build

# Terraform and the bpg/proxmox provider for Proxmox environments (deploy
# phase 5), pinned and checked against the SHA-256 sums HashiCorp and the
# Terraform registry publish (amd64 and arm64). The provider goes into a
# filesystem mirror (sirdar/terraformrc), so `terraform init` never goes
# online. Bump both versions together with deploy/terraform.py (a test
# compares them).
FROM python:3.13-slim AS terraform
ARG TERRAFORM_VERSION=1.16.5
ARG PROXMOX_PROVIDER_VERSION=0.115.0
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl unzip ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN set -eu; arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64) tf_sha=2bc2fcfff033265c9e02ca0351f01794eb122f62a9b2a49a3294b9e49eaab5e4; \
             pv_sha=36c1c6bdcb9c74456ecab30beac94d7984b50deedd236cda8708e5aac924469e ;; \
      arm64) tf_sha=61a50b00485ee4810cf20581ef080fc54d34d666e175c58d9a10501c65c1ccde; \
             pv_sha=7e73903b42fc17078233a6c32fa0b79640c8a2890ed80f69d3fdefba4d0ad085 ;; \
      *) echo "no pinned Terraform for $arch" >&2; exit 1 ;; \
    esac; \
    curl -fsSLo /tmp/terraform.zip \
      "https://releases.hashicorp.com/terraform/${TERRAFORM_VERSION}/terraform_${TERRAFORM_VERSION}_linux_${arch}.zip"; \
    echo "${tf_sha}  /tmp/terraform.zip" | sha256sum -c -; \
    unzip -q /tmp/terraform.zip terraform -d /usr/local/bin; \
    mirror=/opt/terraform/providers/registry.terraform.io/bpg/proxmox; \
    zip="terraform-provider-proxmox_${PROXMOX_PROVIDER_VERSION}_linux_${arch}.zip"; \
    mkdir -p "$mirror"; \
    curl -fsSLo "$mirror/$zip" \
      "https://github.com/bpg/terraform-provider-proxmox/releases/download/v${PROXMOX_PROVIDER_VERSION}/$zip"; \
    echo "${pv_sha}  $mirror/$zip" | sha256sum -c -
COPY sirdar/terraformrc /opt/terraform/terraformrc

FROM python:3.13-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 SIRDAR_STATIC_DIR=/app/static \
    HOME=/home/sirdar SIRDAR_RUNNER_DIR=/app/runner SIRDAR_SNAPSHOTS_DIR=/app/snapshots \
    SIRDAR_TERRAFORM_DIR=/app/terraform
# Deploy pipeline: ansible-runner drives ansible-playbook (both pip packages,
# pinned in pyproject.toml), which connects with ssh, and through sshpass for
# targets that use a password.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssh-client sshpass \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app/api
COPY sirdar/api/pyproject.toml sirdar/api/requirements-esxi.txt ./
# pyVmomi (ESXi targets, deploy phase 6) and its one dependency, checked
# against their published SHA-256 sums; `pip install .` then finds them
# installed.
RUN pip install --no-cache-dir --require-hashes --no-deps -r requirements-esxi.txt
COPY sirdar/api/src ./src
RUN pip install --no-cache-dir .
COPY sirdar/api/alembic.ini ./
COPY sirdar/api/migrations ./migrations
COPY --from=web /app/sirdar/web/dist /app/static
COPY --from=terraform /usr/local/bin/terraform /usr/local/bin/terraform
COPY --from=terraform /opt/terraform /opt/terraform
COPY sirdar/docker-entrypoint.sh /usr/local/bin/sirdar-entrypoint
# uid 10001 gets a home (ssh and Ansible keep small state under $HOME), the
# runner folder, the snapshots folder and the Terraform folder (compose
# mounts sirdar/runner, sirdar/snapshots and sirdar/terraform over them).
# The chown is explicit:
# /home/sirdar already exists as root's when useradd runs, so useradd leaves it.
RUN chmod 755 /usr/local/bin/sirdar-entrypoint \
 && useradd --system --uid 10001 --create-home --home-dir /home/sirdar sirdar \
 && chown sirdar:sirdar /home/sirdar && chmod 700 /home/sirdar \
 && install -d -o sirdar -g sirdar -m 700 /app/runner /app/snapshots /app/terraform
USER sirdar
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD python -c "import sys, urllib.request; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8080/healthz', timeout=4).status == 200 else 1)"
ENTRYPOINT ["sirdar-entrypoint"]
CMD ["serve"]
