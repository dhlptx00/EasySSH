#!/bin/sh
# Prepare a throwaway OpenSSH server for Easy SSH's integration tests.
# Runs as root inside the test container (see Dockerfile), or on a scratch machine.
#   AUTHORIZED_KEY  public key allowed for every test user (required)
#   SSHD_DIR        where the server config and host key go (default /etc/easyssh-it)
#   SSHD_PORT       port to listen on (default 22)
set -eu
: "${AUTHORIZED_KEY:?set AUTHORIZED_KEY to a public key}"
SSHD_DIR="${SSHD_DIR:-/etc/easyssh-it}"
SSHD_PORT="${SSHD_PORT:-22}"
PASSWORD='easy-ssh-it'

mkdir -p "$SSHD_DIR" /run/sshd
[ -f "$SSHD_DIR/host_ed25519" ] || ssh-keygen -q -t ed25519 -N '' -f "$SSHD_DIR/host_ed25519"

user() { # name shell
  id "$1" >/dev/null 2>&1 || useradd -m -s "$2" "$1"
  echo "$1:$PASSWORD" | chpasswd
  home=$(getent passwd "$1" | cut -d: -f6)
  mkdir -p "$home/.ssh"
  echo "$AUTHORIZED_KEY" > "$home/.ssh/authorized_keys"
  chmod 700 "$home/.ssh"
  chmod 600 "$home/.ssh/authorized_keys"
}

# bash, with a PROMPT_COMMAND that ends in ";" (B2) and no HISTCONTROL, so only
# Easy SSH's own history -d keeps the hook out of history (B11).
user esit_bash /bin/bash
home=$(getent passwd esit_bash | cut -d: -f6)
cat > "$home/.bash_profile" <<'RC'
echo "EASY-SSH-IT-LOGIN-BANNER"
[ -f ~/.bashrc ] && . ~/.bashrc
RC
cat > "$home/.bashrc" <<'RC'
HISTCONTROL=
HISTFILE=~/.bash_history
PROMPT_COMMAND='history -a;'
PS1='it-bash:\w\$ '
RC

user esit_zsh "$(command -v zsh)"
home=$(getent passwd esit_zsh | cut -d: -f6)
echo "PS1='it-zsh:%~%# '" > "$home/.zshrc"

user esit_fish "$(command -v fish)"
home=$(getent passwd esit_fish | cut -d: -f6)
mkdir -p "$home/.config/fish"
echo 'function fish_prompt; echo -n "it-fish:"(prompt_pwd)"> "; end' > "$home/.config/fish/config.fish"

# Signs in only through keyboard-interactive (PAM asks "Password:").
user esit_kbd /bin/bash

chown -R esit_bash: "$(getent passwd esit_bash | cut -d: -f6)"
chown -R esit_zsh: "$(getent passwd esit_zsh | cut -d: -f6)"
chown -R esit_fish: "$(getent passwd esit_fish | cut -d: -f6)"
chown -R esit_kbd: "$(getent passwd esit_kbd | cut -d: -f6)"

cat > "$SSHD_DIR/sshd_config" <<CONF
Port $SSHD_PORT
HostKey $SSHD_DIR/host_ed25519
PidFile $SSHD_DIR/sshd.pid
UsePAM yes
PubkeyAuthentication yes
PasswordAuthentication yes
KbdInteractiveAuthentication yes
PrintMotd no
PrintLastLog no
AllowUsers esit_bash esit_zsh esit_fish esit_kbd
Subsystem sftp internal-sftp
Match User esit_kbd
  AuthenticationMethods keyboard-interactive
CONF
echo "sshd config written to $SSHD_DIR/sshd_config"
