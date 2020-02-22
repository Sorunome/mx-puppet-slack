import { Request, Response } from "express";
import { PuppetBridge } from "mx-puppet-bridge";
import { WebClient } from "@slack/web-api";
import { Config } from "./index";

const OK = 200;
const FORBIDDEN = 403;

export class SlackProvisioningAPI {
	constructor(
		private puppet: PuppetBridge,
	) {
		const api = puppet.provisioningAPI;
		api.v1.post("/oauth/access", this.convertOAuthToken);
	}

	private async convertOAuthToken(req: Request, res: Response) {
		try {
			const oauthData = await (new WebClient()).oauth.access({
				client_id: Config().oauth.clientId,
				client_secret: Config().oauth.clientSecret,
				redirect_uri: Config().oauth.redirectUri,
				// @ts-ignore
				code: req.query.code,
			});
			res.status(OK).json(oauthData);
		} catch (err) {
			res.status(FORBIDDEN).json({
				errcode: "M_UNKNOWN",
				error: err,
			});
		}
	}
}
