#!/bin/sh -e

chown -R bridge:bridge /data

if [ ! -f '/data/config.yaml' ]; then
	echo 'No config found'
	exit 1
fi

if [ ! -f '/data/slack-registration.yaml' ]; then
    su -l bridge -c "/usr/local/bin/node '/opt/mx-puppet-slack/build/index.js' \
            -c '/data/config.yaml' \
            -f '/data/slack-registration.yaml' \
            -r"

	echo 'Registration generated.'
	exit 0
fi

su -l bridge -c "/usr/local/bin/node '/opt/mx-puppet-slack/build/index.js' \
    -c '/data/config.yaml' \
    -f '/data/slack-registration.yaml'"
