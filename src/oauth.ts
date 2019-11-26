import { Request, Response } from "express";
import { WebClient } from "@slack/web-api";
import { IRetData } from "mx-puppet-bridge";

import {Config} from "./index";

const forbidden = 403;
const getHtmlResponse = (title, content) => `<!DOCTYPE html>
<html lang="en">
<head>
	<title>Slack OAuth token</title>
	<style>
		body {
			margin-top: 16px;
			text-align: center;
		}
	</style>
</head>
<body>
	<h4>${title}</h4>
	<h2>${content}</h2>
</body>
</html>
`;

export const oauthCallback = async (req: Request, res: Response) => {
	try {
		const oauthData = await (new WebClient()).oauth.access({
			client_id: Config().oauth.clientId,
			client_secret: Config().oauth.clientSecret,
			redirect_uri: Config().oauth.redirectUri,
			// @ts-ignore
			code: req.query.code,
		});
		res.send(getHtmlResponse(
			`Your Slack token for ${oauthData.team_name} is`,
			`<code>${oauthData.access_token}</code>`));
	} catch (err) {
		res.status(forbidden).send(getHtmlResponse("Failed to get OAuth token", err));
	}
};

export const getDataFromStrHook = async (str: string): Promise<IRetData> => {
	const retData = {
		success: false,
	} as IRetData;
	if (!str) {
		retData.error = "Please specify a token to link!";
		if (Config().oauth.enabled) {
			const oauthUrl = `https://slack.com/oauth/authorize?scope=client&client_id=${Config().oauth.clientId}`
				+ `&redirect_uri=${encodeURIComponent(Config().oauth.redirectUri)}`;
			retData.error += `\nYou can get a token via OAuth from ${oauthUrl}`;
		}
		return retData;
	}
	retData.success = true;
	retData.data = {
		token: str.trim(),
	};
	return retData;
};
