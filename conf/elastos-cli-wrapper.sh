#!/bin/bash
# Convenience wrapper installed at /usr/local/bin/elastos. Lets any
# yunohost admin run elastos commands without juggling sudo + env vars.
#
# Templated by ynh: __APP__, __DATA_DIR__.

exec sudo -u __APP__ env \
    HOME=__DATA_DIR__/home \
    XDG_DATA_HOME=__DATA_DIR__/home/.local/share \
    __DATA_DIR__/home/.local/bin/elastos "$@"
