#!/bin/sh
if [ ! -f "/data/config.yaml" ]; then
	echo "No config found"
	exit 1
fi
if [ ! -f "/data/slack-registration.yaml" ]; then
	node /opt/mx-puppet-slack/build/index.js -r
	echo "Registration generated."
	exit 0
fi
node /opt/mx-puppet-slack/build/index.js -c /data/config.yaml -f /data/slack-registration.yaml
