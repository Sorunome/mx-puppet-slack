import { PuppetBridge } from "mx-puppet-bridge";
import { Client } from "./client";
import * as MarkdownIt from "markdown-it";
import * as MarkdownSlack from "markdown-it-slack";
import * as escapeHtml from "escape-html";

const md = MarkdownIt({
	breaks: true, // translate \n to <br>
});

md.use(MarkdownSlack);

export interface ISlackMessageParserOpts {
	puppetId: number;
	puppet: PuppetBridge;
	client: Client;
}

export class SlackMessageParser {
	// largely from https://github.com/matrix-hacks/matrix-puppet-slack/blob/master/app.js "createAndSendPayload"
	public static async parse(
		opts: ISlackMessageParserOpts,
		text: string,
		attachments?: any,
	): Promise<{ msg: string; html: string; }> {
		const messages = [text];
		if (attachments) {
			attachments.forEach((att) => {
				const attMessages = [] as string[];
				if (att.pretext) {
					messages.push(att.pretext);
				}
				if (att.author_name) {
					if (att.author_link) {
						attMessages.push(`[${att.author_name}](${att.author_link})`);
					} else {
						attMessages.push(`${att.author_name}`);
					}
				}
				if (att.title) {
					if (att.title_link) {
						attMessages.push(`*[${att.title}](${att.title_link})*`);
					} else {
						attMessages.push(`*${att.title}*`);
					}
				}
				if (att.text) {
					attMessages.push(`${att.text}`);
				}
				if (att.fields) {
					att.fields.forEach((field) => {
						if (field.title) {
							attMessages.push(`*${field.title}*`);
						}
						if (field.value) {
							attMessages.push(`${field.value}`);
						}
					});
				}
				if ((att.actions instanceof Array) && att.actions.length > 0) {
					attMessages.push(`Actions (Unsupported): ${att.actions.map((o) => `[${o.text}]`).join(" ")}`);
				}
				if (att.footer) {
					attMessages.push(`_${att.footer}_`);
				}
				const attachmentBullet = att.color ? `;BEGIN_FONT_COLOR_HACK_${att.color};●;END_FONT_COLOR_HACK;` : "●";
				attMessages.forEach((attMessage) => {
					messages.push(`${attachmentBullet} ${attMessage}`);
				});
			});
		}
		// combind the messages
		let rawMessage = messages
			.filter((m) => m && (typeof m === "string"))
			.map((m) => m.trim())
			.join("\n")
			.trim();
		// insert @room in place of <!channel> and <!here>
		rawMessage = rawMessage.replace(/<!channel>/g, "@room");
		rawMessage = rawMessage.replace(/<!here>/g, "@room");
		let msg = rawMessage;
		let html = md.render(msg);
		// insert the colour hacks
		html = html.replace(/;BEGIN_FONT_COLOR_HACK_(.*?);/g, "<font color=\"$1\">");
		html = html.replace(/;END_FONT_COLOR_HACK;/g, "</font>");
		msg = msg.replace(/;BEGIN_FONT_COLOR_HACK_(.*?);/g, "");
		msg = msg.replace(/;END_FONT_COLOR_HACK;/g, "");

		// replace user mentions
		let result = null as RegExpExecArray | null;
		result = /<@([a-zA-Z0-9]*)>/g.exec(msg);
		while (result !== null) {
			const u = result[1];
			const user = await opts.client.getUserById(u);
			if (user) {
				msg = msg.replace(result[0], user.name);
			} else {
				msg = msg.replace(result[0], u);
			}
			result = /<@([a-zA-Z0-9]*)>/g.exec(msg);
		}
		result = /&lt;@([a-zA-Z0-9]*)&gt;/g.exec(html);
		while (result !== null) {
			const u = result[1];
			const user = await opts.client.getUserById(u);
			if (user) {
				const id = await opts.puppet.getMxidForUser({
					userId: u,
					puppetId: opts.puppetId,
				});
				const pill = `<a href="https://matrix.to/#/${escapeHtml(id)}">${escapeHtml(user.name)}</a>`;
				html = html.replace(result[0], pill);
			} else {
				html = html.replace(result[0], escapeHtml(u));
			}
			result = /&lt;@([a-zA-Z0-9]*)&gt;/g.exec(html);
		}
		// replace channel mention tags
		result = /<#([a-zA-Z0-9]*)\|([^>]*)>/g.exec(msg);
		while (result !== null) {
			const id = result[1];
			const chan = await opts.client.getChannelById(id);
			if (chan) {
				const name = "#" + chan.name;
				msg = msg.replace(result[0], name);
			} else {
				msg = msg.replace(result[0], id);
			}
			result = /<#([a-zA-Z0-9]*)\|([^>]*)>/g.exec(msg);
		}
		result = /&lt;#([a-zA-Z0-9]*)\|([^&]*)&gt;/g.exec(html);
		while (result !== null) {
			const id = result[1];
			const chan = await opts.client.getChannelById(id);
			if (chan) {
				const alias = await opts.puppet.getMxidForChan({
					roomId: id,
					puppetId: opts.puppetId,
				});
				const name = "#" + chan.name;
				const pill = `<a href="https://matrix.to/#/${escapeHtml(alias)}">${escapeHtml(name)}</a>`;
				html = html.replace(result[0], pill);
			} else {
				html = html.replace(result[0], escapeHtml(id));
			}
			result = /&lt;#([a-zA-Z0-9]*)\|([^&]*)&gt;/g.exec(html);
		}
		return { msg, html };
	}
}
