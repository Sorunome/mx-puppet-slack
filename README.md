[![Support room on Matrix](https://img.shields.io/matrix/mx-puppet-discord:sorunome.de.svg?label=%23mx-puppet-discord%3Asorunome.de&logo=matrix&server_fqdn=sorunome.de)](https://matrix.to/#/#mx-puppet-discord:sorunome.de) [![donate](https://liberapay.com/assets/widgets/donate.svg)](https://liberapay.com/Sorunome/donate)

# mx-puppet-slack
This is a slack puppeting bridge for matrix. It is based on [mx-puppet-bridge](https://github.com/Sorunome/mx-puppet-bridge).

## Docker

Docker image can be found at https://hub.docker.com/r/sorunome/mx-puppet-slack

For docker you probably want the following changes in `config.yaml`:

```yaml
bindAddress: '0.0.0.0'
filename: '/data/database.db'
file: '/data/bridge.log'
```

Also check the config for other values, like your homeserver domain.

## Start using

Get a legacy token from https://api.slack.com/custom-integrations/legacy-tokens and then chat with the bot user (`@_slackpuppet_bot:domain.tld` unless you changed the config):

    link <token>
