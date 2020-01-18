import * as Parser from "node-html-parser";
import { Util, PuppetBridge } from "mx-puppet-bridge";

const MATRIX_TO_LINK = "https://matrix.to/#/";

export interface IMatrixMessageParserOpts {
	listDepth?: number;
	puppetId: number;
	puppet: PuppetBridge;
}

export class MatrixMessageProcessor {
	public static async parse(
		opts: IMatrixMessageParserOpts,
		eventContent: any,
	): Promise<string> {
		let reply = "";
		if (eventContent.formatted_body) {
			// init opts
			opts.listDepth = 0;
			// parser needs everything in html elements
			// so we wrap everything in <div> just to be sure that all is wrapped
			const parsed = Parser.parse(`<div>${eventContent.formatted_body}</div>`, {
				lowerCaseTagName: true,
				pre: true,
			} as any);
			reply = await this.walkNode(opts, parsed);
			reply = reply.replace(/\s*$/, ""); // trim off whitespace at end
		} else {
			reply = eventContent.body;
		}
		return reply;
	}

	private static listBulletPoints: string[] = ["●", "○", "■", "‣"];

	private static parsePreContent(opts: IMatrixMessageParserOpts, node: Parser.HTMLElement): string {
		let text = node.text;
		const match = text.match(/^<code([^>]*)>/i);
		if (!match) {
			if (text[0] !== "\n") {
				text = "\n" + text;
			}
			return text;
		}
		// remove <code> opening-tag
		text = text.substr(match[0].length);
		// remove </code> closing tag
		text = text.replace(/<\/code>$/i, "");
		if (text[0] !== "\n") {
			text = "\n" + text;
		}
		// slack doesn't support code language
		return text;
	}

	private static async parseLinkContent(opts: IMatrixMessageParserOpts, node: Parser.HTMLElement): Promise<string> {
		const attrs = node.attributes;
		const content = await this.walkChildNodes(opts, node);
		if (!attrs.href || content === attrs.href) {
			return content;
		}
		return `[${content}](${attrs.href})`;
	}

	private static async parseUser(opts: IMatrixMessageParserOpts, id: string): Promise<string> {
		const parts = opts.puppet.userSync.getPartsFromMxid(id);
		if (!parts) {
			return "";
		}
		if (parts.puppetId !== opts.puppetId) {
			return "";
		}
		return `<@${parts.userId}>`;
	}

	private static async parseChannel(opts: IMatrixMessageParserOpts, id: string): Promise<string> {
		const parts = await opts.puppet.roomSync.getPartsFromMxid(id);
		if (!parts) {
			return "";
		}
		if (parts.puppetId !== opts.puppetId) {
			return "";
		}
		return `<#${parts.roomId}|>`;
	}

	private static async parsePillContent(opts: IMatrixMessageParserOpts, node: Parser.HTMLElement): Promise<string> {
		const attrs = node.attributes;
		if (!attrs.href || !attrs.href.startsWith(MATRIX_TO_LINK)) {
			return await this.parseLinkContent(opts, node);
		}
		const id = attrs.href.replace(MATRIX_TO_LINK, "");
		let reply = "";
		switch (id[0]) {
			case "@":
				// user pill
				reply = await this.parseUser(opts, id);
				break;
			case "#":
				reply = await this.parseChannel(opts, id);
				break;
		}
		if (!reply) {
			return await this.parseLinkContent(opts, node);
		}
		return reply;
	}

	private static async parseImageContent(opts: IMatrixMessageParserOpts, node: Parser.HTMLElement): Promise<string> {
		const EMOTE_NAME_REGEX = /^:?(\w+):?/;
		const attrs = node.attributes;
		const name = attrs.alt || attrs.title || "";
		return attrs.src ? `![${name}](${attrs.src})` : name;
	}

	private static async parseBlockquoteContent(
		opts: IMatrixMessageParserOpts,
		node: Parser.HTMLElement,
	): Promise<string> {
		let msg = await this.walkChildNodes(opts, node);

		msg = msg.split("\n").map((s) => {
			return "> " + s;
		}).join("\n");
		msg = msg + "\n\n";
		return msg;
	}

	private static async parseSpanContent(opts: IMatrixMessageParserOpts, node: Parser.HTMLElement): Promise<string> {
		const content = await this.walkChildNodes(opts, node);
		const attrs = node.attributes;
		if (attrs["data-mx-spoiler"] !== undefined) {
			const spoilerReason = attrs["data-mx-spoiler"];
			if (spoilerReason) {
				return `(Spoiler for ${spoilerReason}: ${content})`;
			}
			return `(Spoiler: ${content})`;
		}
		return content;
	}

	private static async parseUlContent(opts: IMatrixMessageParserOpts, node: Parser.HTMLElement): Promise<string> {
		opts.listDepth!++;
		const entries = await this.arrayChildNodes(opts, node, ["li"]);
		opts.listDepth!--;
		const bulletPoint = this.listBulletPoints[opts.listDepth! % this.listBulletPoints.length];

		let msg = entries.map((s) => {
			return `${"    ".repeat(opts.listDepth!)}${bulletPoint} ${s}`;
		}).join("\n");

		if (opts.listDepth! === 0) {
			msg = `\n${msg}\n\n`;
		}
		return msg;
	}

	private static async parseOlContent(opts: IMatrixMessageParserOpts, node: Parser.HTMLElement): Promise<string> {
		opts.listDepth!++;
		const entries = await this.arrayChildNodes(opts, node, ["li"]);
		opts.listDepth!--;
		let entry = 0;
		const attrs = node.attributes;
		if (attrs.start && attrs.start.match(/^[0-9]+$/)) {
			entry = parseInt(attrs.start, 10) - 1;
		}

		let msg = entries.map((s) => {
			entry++;
			return `${"    ".repeat(opts.listDepth!)}${entry}. ${s}`;
		}).join("\n");

		if (opts.listDepth! === 0) {
			msg = `\n${msg}\n\n`;
		}
		return msg;
	}

	private static async arrayChildNodes(
		opts: IMatrixMessageParserOpts,
		node: Parser.Node,
		types: string[] = [],
	): Promise<string[]> {
		const replies: string[] = [];
		await Util.AsyncForEach(node.childNodes, async (child) => {
			if (types.length && (
				child.nodeType === Parser.NodeType.TEXT_NODE
				|| !types.includes((child as Parser.HTMLElement).tagName)
			)) {
				return;
			}
			replies.push(await this.walkNode(opts, child));
		});
		return replies;
	}

	private static async walkChildNodes(opts: IMatrixMessageParserOpts, node: Parser.Node): Promise<string> {
		let reply = "";
		await Util.AsyncForEach(node.childNodes, async (child) => {
			reply += await this.walkNode(opts, child);
		});
		return reply;
	}

	private static async walkNode(opts: IMatrixMessageParserOpts, node: Parser.Node): Promise<string> {
		if (node.nodeType === Parser.NodeType.TEXT_NODE) {
			// ignore \n between single nodes
			if ((node as Parser.TextNode).text === "\n") {
				return "";
			}
			return (node as Parser.TextNode).text;
		} else if (node.nodeType === Parser.NodeType.ELEMENT_NODE) {
			const nodeHtml = node as Parser.HTMLElement;
			switch (nodeHtml.tagName) {
				case "em":
				case "i":
					return `_${await this.walkChildNodes(opts, nodeHtml)}_`;
				case "strong":
				case "b":
					return `*${await this.walkChildNodes(opts, nodeHtml)}*`;
				case "del":
					return `~${await this.walkChildNodes(opts, nodeHtml)}~`;
				case "code":
					return `\`${nodeHtml.text}\``;
				case "pre":
					return `\`\`\`${this.parsePreContent(opts, nodeHtml)}\`\`\``;
				case "a":
					return await this.parsePillContent(opts, nodeHtml);
				case "img":
					return await this.parseImageContent(opts, nodeHtml);
				case "br":
					return "\n";
				case "blockquote":
					return await this.parseBlockquoteContent(opts, nodeHtml);
				case "ul":
					return await this.parseUlContent(opts, nodeHtml);
				case "ol":
					return await this.parseOlContent(opts, nodeHtml);
				case "mx-reply":
					return "";
				case "hr":
					return "\n----------\n";
				case "h1":
				case "h2":
				case "h3":
				case "h4":
				case "h5":
				case "h6":
					const level = parseInt(nodeHtml.tagName[1], 10);
					return `*${"#".repeat(level)} ${await this.walkChildNodes(opts, nodeHtml)}*\n`;
				case "span":
					return await this.parseSpanContent(opts, nodeHtml);
				default:
					return await this.walkChildNodes(opts, nodeHtml);
			}
		}
		return "";
	}
}
