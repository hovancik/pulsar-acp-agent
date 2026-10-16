FROM mcr.microsoft.com/devcontainers/base:ubuntu24.04

RUN rm -f /etc/sudoers.d/vscode \
    && mkdir -p /home/vscode/pulsar-acp-agent/node_modules \
    && chown -R vscode:vscode /home/vscode/pulsar-acp-agent
