import { Response } from "express";
import { PuppetBridge, IAuthedRequest } from "mx-puppet-bridge";
import { convertOAuthToken } from "./oauth";

const CREATED = 201;
const FORBIDDEN = 403;

export class SlackProvisioningAPI {
	constructor(
		private puppet: PuppetBridge,
	) {
		const api = puppet.provisioningAPI;
		api.v1.post("/oauth/link", this.linkOAuthCode);
	}

	private async linkOAuthCode(req: IAuthedRequest, res: Response) {
		const oauthData = await convertOAuthToken(req.body.code, req.body.redirect_uri);
		if (!oauthData.ok) {
			res.status(FORBIDDEN).json({
				errcode: "M_UNKNOWN",
				error: oauthData.error,
			});
			return;
		}
		const puppetId = await this.puppet.provisioner.new(req.userId, {
			token: oauthData.access_token as string,
		});
		res.status(CREATED).json({ puppet_id: puppetId });
	}
}
