export class SlackConfigWrap {
	public oauth: OAuthConfig = new OAuthConfig();
	public slack: SlackConfig = new SlackConfig();

	public applyConfig(newConfig: {[key: string]: any}, configLayer: {[key: string]: any} = this) {
		Object.keys(newConfig).forEach((key) => {
			if (configLayer[key] instanceof Object && !(configLayer[key] instanceof Array)) {
				this.applyConfig(newConfig[key], configLayer[key]);
			} else {
				configLayer[key] = newConfig[key];
			}
		});
	}
}

class OAuthConfig {
	public enabled = false;
	public clientId = "";
	public clientSecret = "";
	public redirectPath = "";
	public redirectUri = "";
}

class SlackConfig {
	public path: string = "/_matrix/slack/client";
}
