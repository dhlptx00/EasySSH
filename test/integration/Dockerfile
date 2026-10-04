# A throwaway OpenSSH server for Easy SSH's integration tests. Never expose it.
#   docker build -t easyssh-it test/integration
#   docker run -d -p 2222:22 -e AUTHORIZED_KEY="$(cat key.pub)" easyssh-it
FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssh-server bash zsh fish passwd vim-tiny \
 && rm -rf /var/lib/apt/lists/* \
 && sed -i 's/^session\s\+required\s\+pam_loginuid.so/session optional pam_loginuid.so/' /etc/pam.d/sshd
COPY setup.sh /usr/local/bin/easyssh-it-setup
RUN chmod +x /usr/local/bin/easyssh-it-setup
EXPOSE 22
CMD ["/bin/sh", "-c", "easyssh-it-setup && exec /usr/sbin/sshd -D -e -f /etc/easyssh-it/sshd_config"]
