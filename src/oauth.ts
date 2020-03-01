import { Request, Response } from "express";
import { WebClient, WebAPICallResult } from "@slack/web-api";
import { IRetData } from "mx-puppet-bridge";
import * as escapeHtml from "escape-html";

import { Config } from "./index";

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

export const convertOAuthToken = async (code: string, redirectUri?: string): Promise<WebAPICallResult> => {
	return (new WebClient()).oauth.access({
		client_id: Config().oauth.clientId,
		client_secret: Config().oauth.clientSecret,
		redirect_uri: redirectUri || Config().oauth.redirectUri,
		code,
	});
};

export const oauthCallback = async (req: Request, res: Response) => {
	const oauthData = await convertOAuthToken(req.query.code);
	if (oauthData.ok) {
		res.send(getHtmlResponse(
			`Your Slack token for ${escapeHtml(oauthData.team_name)} is`,
			`<code>${escapeHtml(oauthData.access_token)}</code>`));
	} else {
		res.status(forbidden).send(getHtmlResponse("Failed to get OAuth token", oauthData.error));
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
	const parts = str.trim().split(" ");
	const token = parts[0];
	let cookie: string | null = null;
	if (token.startsWith("xoxc")) {
		if (!parts[1]) {
			retData.error = "Please specify the `d` cookie for `xoxc` tokens!";
			return retData;
		}
		cookie = parts[1];
	}
	retData.success = true;
	retData.data = {
		token,
		cookie,
	};
	return retData;
};
