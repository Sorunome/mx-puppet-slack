import {
	PuppetBridge,
	Log,
	IReceiveParams,
	IMessageEvent,
	IRemoteUser,
	IRemoteRoom,
	IRemoteGroup,
	IFileEvent,
	Util,
	IRetList,
	IStringFormatterVars,
	MessageDeduplicator,
	ISendingUser,
} from "mx-puppet-bridge";
import {
	SlackMessageParser, ISlackMessageParserOpts, MatrixMessageParser, IMatrixMessageParserOpts,
} from "matrix-slack-parser";
import * as Slack from "soru-slack-client";
import * as Emoji from "node-emoji";
import { SlackProvisioningAPI } from "./api";
import { SlackStore } from "./store";
import * as escapeHtml from "escape-html";
import { Config } from "./index";

const log = new Log("SlackPuppet:slack");

interface ISlackPuppet {
	client: Slack.Client;
	data: any;
	clientStopped: boolean;
}

interface ISlackPuppets {
	[puppetId: number]: ISlackPuppet;
}

export class App {
	private puppets: ISlackPuppets = {};
	private tsThreads: {[ts: string]: string} = {};
	private threadSendTs: {[ts: string]: string} = {};
	private slackMessageParser: SlackMessageParser;
	private matrixMessageParser: MatrixMessageParser;
	private messageDeduplicator: MessageDeduplicator;
	private provisioningAPI: SlackProvisioningAPI;
	private store: SlackStore;
	constructor(
		private puppet: PuppetBridge,
	) {
		this.slackMessageParser = new SlackMessageParser();
		this.matrixMessageParser = new MatrixMessageParser();
		this.messageDeduplicator = new MessageDeduplicator();
		this.provisioningAPI = new SlackProvisioningAPI(puppet);
		this.store = new SlackStore(puppet.store);
	}

	public async init(): Promise<void> {
		await this.store.init();
	}

	public async getUserParams(puppetId: number, user: Slack.User | Slack.Bot): Promise<IRemoteUser> {
		if (user.partial) {
			await user.load();
		}
		const nameVars: IStringFormatterVars = {
			team: user.team.name,
			name: user.displayName,
		};
		let userId = user.fullId;
		if (user instanceof Slack.Bot) {
			userId += `-${user.displayName}`;
		}
		return {
			puppetId,
			userId,
			avatarUrl: user.iconUrl,
			nameVars,
		};
	}

	public async getRoomParams(puppetId: number, chan: Slack.Channel): Promise<IRemoteRoom> {
		if (chan.type === "im") {
			return {
				puppetId,
				roomId: chan.fullId,
				isDirect: true,
			};
		}
		if (chan.partial) {
			await chan.load();
		}
		const nameVars: IStringFormatterVars = {
			name: chan.name,
			team: chan.team.name,
			type: chan.type,
		};
		return {
			puppetId,
			roomId: chan.fullId,
			nameVars: chan.type === "mpim" ? undefined : nameVars,
			avatarUrl: chan.team.iconUrl,
			topic: chan.topic,
			isDirect: false,
			groupId: chan.type === "mpim" ? undefined : chan.team.id,
		};
	}

	public async getGroupParams(puppetId: number, team: Slack.Team): Promise<IRemoteGroup> {
		if (team.partial) {
			await team.load();
		}
		const roomIds: string[] = [];
		let description = `<h1>${escapeHtml(team.name)}</h1>`;
		description += `<h2>Channels:</h2><ul>`;
		for (const [, chan] of team.channels) {
			if (!["channel", "group"].includes(chan.type)) {
				continue;
			}
			roomIds.push(chan.fullId);
			const mxid = await this.puppet.getMxidForRoom({
				puppetId,
				roomId: chan.fullId,
			});
			const url = "https://matrix.to/#/" + mxid;
			const name = escapeHtml(chan.name);
			description += `<li>${name}: <a href="${url}">${name}</a></li>`;
		}
		description += "</ul>";
		return {
			puppetId,
			groupId: team.id,
			nameVars: {
				name: team.name,
			},
			avatarUrl: team.iconUrl,
			roomIds,
			longDescription: description,
		};
	}

	public async getSendParams(
		puppetId: number,
		msgOrChannel: Slack.Message | Slack.Channel,
		user?: Slack.User | Slack.Bot,
	): Promise<IReceiveParams> {
		let externalUrl: string | undefined;
		let eventId: string | undefined;
		let channel: Slack.Channel;
		if (!user) {
			user = (msgOrChannel as Slack.Message).author;
			const msg = msgOrChannel as Slack.Message;
			channel = (msgOrChannel as Slack.Message).channel;
			externalUrl = `https://${user.team.domain}.slack.com/archives/${channel.id}/p${msg.ts}`;
			eventId = msg.ts;
		} else {
			channel = msgOrChannel as Slack.Channel;
		}
		if (user.team.partial) {
			await user.team.load();
		}
		return {
			room: await this.getRoomParams(puppetId, channel),
			user: await this.getUserParams(puppetId, user),
			eventId,
			externalUrl,
		};
	}

	public async removePuppet(puppetId: number) {
		log.info(`Removing puppet: puppetId=${puppetId}`);
		await this.stopClient(puppetId);
		delete this.puppets[puppetId];
	}

	public async stopClient(puppetId: number) {
		const p = this.puppets[puppetId];
		if (!p) {
			return;
		}
		p.clientStopped = true;
		await p.client.disconnect();
	}

	public async startClient(puppetId: number) {
		const p = this.puppets[puppetId];
		if (!p) {
			return;
		}
		const opts: Slack.IClientOpts = {};
		if (p.data.token) {
			opts.token = p.data.token;
		}
		if (p.data.cookie) {
			opts.cookie = p.data.cookie;
		}
		if (p.data.appId) {
			opts.events = {
				express: {
					app: this.puppet.AS.expressAppInstance,
					path: Config().slack.path,
				},
				appId: p.data.appId,
				clientId: p.data.clientId,
				clientSecret: p.data.clientSecret,
				signingSecret: p.data.signingSecret,
				storeToken: async (t: Slack.IStoreToken) => {
					await this.store.storeToken(puppetId, t);
				},
				getTokens: async (): Promise<Slack.IStoreToken[]> => {
					return await this.store.getTokens(puppetId);
				},
			};
		}
		const client = new Slack.Client(opts);
		client.on("connected", async () => {
			await this.puppet.sendStatusMessage(puppetId, "connected");
			for (const [, user] of client.users) {
				const d = this.puppets[puppetId].data;
				d.team = {
					id: user.team.id,
					name: user.team.name,
				};
				d.self = {
					id: user.fullId,
					name: user.name,
				};
				await this.puppet.setUserId(puppetId, user.fullId);
				await this.puppet.setPuppetData(puppetId, d);
				break;
			}
		});
		client.on("disconnected", async () => {
			if (p.clientStopped) {
				return;
			}
			log.info(`Lost connection for puppet ${puppetId}, reconnecting in a minute...`);
			await this.puppet.sendStatusMessage(puppetId, "Lost connection, reconnecting in a minute...");
			const MINUTE = 60000;
			await Util.sleep(MINUTE);
			try {
				await this.stopClient(puppetId);
				await this.startClient(puppetId);
			} catch (err) {
				log.warn("Failed to restart client", err);
				await this.puppet.sendStatusMessage(puppetId, "Failed to restart client");
			}
		});
		client.on("message", async (msg: Slack.Message) => {
			try {
				log.verbose("Got new message event");
				await this.handleSlackMessage(puppetId, msg);
			} catch (err) {
				log.error("Error handling slack message event", err);
			}
		});
		client.on("messageChanged", async (msg1: Slack.Message, msg2: Slack.Message) => {
			try {
				log.verbose("Got new message changed event");
				await this.handleSlackMessageChanged(puppetId, msg1, msg2);
			} catch (err) {
				log.error("Error handling slack messageChanged event", err);
			}
		});
		client.on("messageDeleted", async (msg: Slack.Message) => {
			try {
				log.verbose("Got new message deleted event");
				await this.handleSlackMessageDeleted(puppetId, msg);
			} catch (err) {
				log.error("Error handling slack messageDeleted event", err);
			}
		});
		client.on("addUser", async (user: Slack.User) => {
			await this.puppet.updateUser(await this.getUserParams(puppetId, user));
		});
		client.on("changeUser", async (_, user: Slack.User) => {
			await this.puppet.updateUser(await this.getUserParams(puppetId, user));
		});
		client.on("addChannel", async (chan: Slack.Channel) => {
			await this.puppet.updateRoom(await this.getRoomParams(puppetId, chan));
		});
		client.on("changeChannel", async (_, chan: Slack.Channel) => {
			await this.puppet.updateRoom(await this.getRoomParams(puppetId, chan));
		});
		client.on("addTeam", async (team: Slack.Team) => {
			await this.puppet.updateGroup(await this.getGroupParams(puppetId, team));
		});
		client.on("changeTeam", async (_, team: Slack.Team) => {
			await this.puppet.updateGroup(await this.getGroupParams(puppetId, team));
		});
		client.on("typing", async (channel: Slack.Channel, user: Slack.User) => {
			const params = await this.getSendParams(puppetId, channel, user);
			await this.puppet.setUserTyping(params, true);
		});
		client.on("presenceChange", async (user: Slack.User, presence: string) => {
			log.verbose("Received presence change");
			let matrixPresence = {
				active: "online",
				away: "offline",
			}[presence];
			if (!matrixPresence) {
				matrixPresence = "offline";
			}
			await this.puppet.setUserPresence({
				userId: user.fullId,
				puppetId,
			}, matrixPresence);
		});
		client.on("reactionAdded", async (reaction: Slack.Reaction) => {
			log.verbose("Received new reaction");
			const params = await this.getSendParams(puppetId, reaction.message);
			const e = Emoji.get(reaction.reaction);
			if (!e) {
				return;
			}
			await this.puppet.sendReaction(params, reaction.message.ts, e);
		});
		client.on("reactionRemoved", async (reaction: Slack.Reaction) => {
			log.verbose("Received reaction remove");
			const params = await this.getSendParams(puppetId, reaction.message);
			const e = Emoji.get(reaction.reaction);
			if (!e) {
				return;
			}
			await this.puppet.removeReaction(params, reaction.message.ts, e);
		});
		p.client = client;
		try {
			await client.connect();
		} catch (err) {
			log.warn("Failed to connect client", err);
			await this.puppet.sendStatusMessage(puppetId, `Failed to connect client: ${err}`);
			throw err;
		}
	}

	public async newPuppet(puppetId: number, data: any) {
		log.info(`Adding new Puppet: puppetId=${puppetId}`);
		if (this.puppets[puppetId]) {
			await this.removePuppet(puppetId);
		}
		const client = new Slack.Client({});
		this.puppets[puppetId] = {
			client,
			data,
			clientStopped: false,
		};
		await this.startClient(puppetId);
	}

	public async deletePuppet(puppetId: number) {
		log.info(`Got signal to quit Puppet: puppetId=${puppetId}`);
		await this.stopClient(puppetId);
		await this.removePuppet(puppetId);
	}

	public async handleSlackMessage(puppetId: number, msg: Slack.Message) {
		if (msg.empty && !msg.attachments && !msg.files) {
			return; // nothing to do
		}
		if (msg.author instanceof Slack.Bot) {
			const appUserId = msg.client.users.get(msg.author.team.id);
			if (msg.author.partial) {
				await msg.author.load();
			}
			if (appUserId && msg.author.user && appUserId.id === msg.author.user.id) {
				return;
			}
		}
		const params = await this.getSendParams(puppetId, msg);
		const client = this.puppets[puppetId].client;
		const parserOpts = this.getSlackMessageParserOpts(puppetId, msg.channel.team);
		log.verbose("Received message.");
		const dedupeKey = `${puppetId};${params.room.roomId}`;
		if (!(msg.empty && !msg.attachments) &&
			!await this.messageDeduplicator.dedupe(dedupeKey, params.user.userId, params.eventId, msg.text || "")) {
			const res = await this.slackMessageParser.FormatMessage(parserOpts, {
				text: msg.text || "",
				blocks: msg.blocks || undefined,
				attachments: msg.attachments || undefined,
			});
			const opts = {
				body: res.body,
				formattedBody: res.formatted_body,
				emote: msg.meMessage,
			};
			if (msg.threadTs) {
				const replyTs = this.threadSendTs[msg.threadTs] || msg.threadTs;
				this.threadSendTs[msg.threadTs] = msg.ts;
				this.tsThreads[msg.ts] = msg.threadTs;
				await this.puppet.sendReply(params, replyTs, opts);
			} else {
				await this.puppet.sendMessage(params, opts);
			}
		}
		if (msg.files) {
			// this has files
			for (const f of msg.files) {
				if (f.title &&
					await this.messageDeduplicator.dedupe(dedupeKey, params.user.userId, params.eventId, "file:" + f.title)) {
					// skip this, we sent it!
					continue;
				}
				try {
					const buffer = await client.downloadFile(f.url_private);
					await this.puppet.sendFileDetect(params, buffer, f.name);
				} catch (err) {
					await this.puppet.sendMessage(params, {
						body: `sent a file: ${f.url_private}`,
						emote: true,
					});
				}
				if (f.initial_comment) {
					const ret = await this.slackMessageParser.FormatText(parserOpts, f.initial_comment);
					await this.puppet.sendMessage(params, {
						body: ret.body,
						formattedBody: ret.formatted_body,
					});
				}
			}
		}
	}

	public async handleSlackMessageChanged(puppetId: number, msg1: Slack.Message, msg2: Slack.Message) {
		if (msg1.text === msg2.text) {
			return;
		}
		if (msg1.author instanceof Slack.Bot) {
			const appUserId = msg1.client.users.get(msg1.author.team.id);
			if (msg1.author.partial) {
				await msg1.author.load();
			}
			if (appUserId && msg1.author.user && appUserId.id === msg1.author.user.id) {
				return;
			}
		}
		const params = await this.getSendParams(puppetId, msg2);
		const client = this.puppets[puppetId].client;
		const parserOpts = this.getSlackMessageParserOpts(puppetId, msg1.channel.team);
		log.verbose("Received message edit");
		const dedupeKey = `${puppetId};${params.room.roomId}`;
		if (await this.messageDeduplicator.dedupe(dedupeKey, params.user.userId, params.eventId, msg2.text || "")) {
			return;
		}
		const res = await this.slackMessageParser.FormatMessage(parserOpts, {
			text: msg2.text || "",
			blocks: msg2.blocks || undefined,
		});
		await this.puppet.sendEdit(params, msg1.ts, {
			body: res.body,
			formattedBody: res.formatted_body,
		});
	}

	public async handleSlackMessageDeleted(puppetId: number, msg: Slack.Message) {
		if (msg.author instanceof Slack.Bot) {
			const appUserId = msg.client.users.get(msg.author.team.id);
			if (msg.author.partial) {
				await msg.author.load();
			}
			if (appUserId && msg.author.user && appUserId.id === msg.author.user.id) {
				return;
			}
		}
		const params = await this.getSendParams(puppetId, msg);
		await this.puppet.sendRedact(params, msg.ts);
	}

	public async handleMatrixMessage(room: IRemoteRoom, data: IMessageEvent, asUser: ISendingUser | null, event: any) {
		const p = this.puppets[room.puppetId];
		if (!p) {
			return;
		}
		const chan = p.client.getChannel(room.roomId);
		if (!chan) {
			log.warn(`Room ${room.roomId} not found!`);
			return;
		}
		const msg = await this.matrixMessageParser.FormatMessage(
			this.getMatrixMessageParserOpts(room.puppetId),
			event.content,
		);

		if (msg.text.match(/^\/[0-9a-zA-Z]+/)) {
			const [command, parameters] = msg.text.split(/ (.+)/);
			const retEventId = await chan.sendCommand(command, parameters);
			await this.puppet.eventSync.insert(room, data.eventId!, retEventId);

			return;
		}

		if (asUser) {
			if (data.emote) {
				msg.text = `_${msg.text}_`;
			}
			data.emote = false;
			// add the fallback
			if (!p.data.appId) {
				msg.text = `*${asUser.displayname}*: ${msg.text}`;
			}
		}
		const dedupeKey = `${room.puppetId};${room.roomId}`;
		this.messageDeduplicator.lock(dedupeKey, p.data.self.id, msg.text);
		let eventId = "";
		if (asUser && p.data.appId) {
			eventId = await chan.sendMessage(msg, {
				asUser: false,
				username: asUser.displayname,
				iconUrl: asUser.avatarUrl,
			});
		} else if (data.emote) {
			eventId = await chan.sendMeMessage(msg);
		} else {
			eventId = await chan.sendMessage(msg, {
				asUser: true,
			});
		}
		this.messageDeduplicator.unlock(dedupeKey, p.data.self.id, eventId);
		if (eventId) {
			await this.puppet.eventSync.insert(room, data.eventId!, eventId);
		}
	}

	public async handleMatrixEdit(
		room: IRemoteRoom,
		eventId: string,
		data: IMessageEvent,
		asUser: ISendingUser | null,
		event: any,
	) {
		const p = this.puppets[room.puppetId];
		if (!p) {
			return;
		}
		const chan = p.client.getChannel(room.roomId);
		if (!chan) {
			log.warn(`Room ${room.roomId} not found!`);
			return;
		}
		const msg = await this.matrixMessageParser.FormatMessage(
			this.getMatrixMessageParserOpts(room.puppetId),
			event.content["m.new_content"],
		);
		if (asUser) {
			if (data.emote) {
				msg.text = `_${msg.text}_`;
			}
			data.emote = false;
			// add the fallback
			if (!p.data.appId) {
				msg.text = `*${asUser.displayname}*: ${msg.text}`;
			}
		}
		const dedupeKey = `${room.puppetId};${room.roomId}`;
		this.messageDeduplicator.lock(dedupeKey, p.data.self.id, msg.text);
		let newEventId = "";
		if (asUser && p.data.appId) {
			newEventId = await chan.editMessage(msg, eventId, {
				asUser: false,
				username: asUser.displayname,
				iconUrl: asUser.avatarUrl,
			});
		} else {
			newEventId = await chan.editMessage(msg, eventId, {
				asUser: true,
			});
		}
		this.messageDeduplicator.unlock(dedupeKey, p.data.self.id, newEventId);
		if (newEventId) {
			await this.puppet.eventSync.insert(room, data.eventId!, newEventId);
		}
	}

	public async handleMatrixReply(
		room: IRemoteRoom,
		eventId: string,
		data: IMessageEvent,
		asUser: ISendingUser | null,
		event: any,
	) {
		const p = this.puppets[room.puppetId];
		if (!p) {
			return;
		}
		log.verbose(`Got reply to send of ts=${eventId}`);
		const chan = p.client.getChannel(room.roomId);
		if (!chan) {
			log.warn(`Room ${room.roomId} not found!`);
			return;
		}
		let tsThread = eventId;
		while (this.tsThreads[tsThread]) {
			tsThread = this.tsThreads[tsThread];
		}
		log.verbose(`Determined thread ts=${tsThread}`);
		const msg = await this.matrixMessageParser.FormatMessage(
			this.getMatrixMessageParserOpts(room.puppetId),
			event.content,
		);
		if (asUser) {
			if (data.emote) {
				msg.text = `_${msg.text}_`;
			}
			data.emote = false;
			// add the fallback
			if (!p.data.appId) {
				msg.text = `*${asUser.displayname}*: ${msg.text}`;
			}
		}
		const dedupeKey = `${room.puppetId};${room.roomId}`;
		this.messageDeduplicator.lock(dedupeKey, p.data.self.id, msg.text);
		let newEventId = "";
		if (asUser && p.data.appId) {
			newEventId = await chan.sendMessage(msg, {
				asUser: false,
				username: asUser.displayname,
				iconUrl: asUser.avatarUrl,
				threadTs: tsThread,
			});
		} else {
			newEventId = await chan.sendMessage(msg, {
				asUser: true,
				threadTs: tsThread,
			});
		}
		this.messageDeduplicator.unlock(dedupeKey, p.data.self.id, newEventId);
		if (newEventId) {
			this.tsThreads[newEventId] = tsThread;
			await this.puppet.eventSync.insert(room, data.eventId!, newEventId);
		}
	}

	public async handleMatrixRedact(room: IRemoteRoom, eventId: string, asUser: ISendingUser | null, event: any) {
		const p = this.puppets[room.puppetId];
		if (!p) {
			return;
		}
		const chan = p.client.getChannel(room.roomId);
		if (!chan) {
			log.warn(`Room ${room.roomId} not found!`);
			return;
		}
		if (asUser && p.data.appId) {
			await chan.deleteMessage(eventId, {
				asUser: true,
				username: asUser.displayname,
				iconUrl: asUser.avatarUrl,
			});
		} else {
			await chan.deleteMessage(eventId, {
				asUser: true,
			});
		}
	}

	public async handleMatrixReaction(room: IRemoteRoom, eventId: string, reaction: string, asUser: ISendingUser | null) {
		const p = this.puppets[room.puppetId];
		if (!p || asUser) {
			return;
		}
		const chan = p.client.getChannel(room.roomId);
		if (!chan) {
			log.warn(`Room ${room.roomId} not found!`);
			return;
		}
		const e = Emoji.find(reaction);
		if (!e) {
			return;
		}
		await chan.sendReaction(eventId, e.key);
	}

	public async handleMatrixRemoveReaction(
		room: IRemoteRoom,
		eventId: string,
		reaction: string,
		asUser: ISendingUser | null,
	) {
		const p = this.puppets[room.puppetId];
		if (!p || asUser) {
			return;
		}
		const chan = p.client.getChannel(room.roomId);
		if (!chan) {
			log.warn(`Room ${room.roomId} not found!`);
			return;
		}
		const e = Emoji.find(reaction);
		if (!e) {
			return;
		}
		await chan.removeReaction(eventId, e.key);
	}

	public async handleMatrixImage(
		room: IRemoteRoom,
		data: IFileEvent,
		asUser: ISendingUser | null,
		event: any,
	) {
		const p = this.puppets[room.puppetId];
		if (!p) {
			return;
		}
		if (!asUser) {
			await this.handleMatrixFile(room, data, asUser, event);
			return;
		}
		const chan = p.client.getChannel(room.roomId);
		if (!chan) {
			log.warn(`Room ${room.roomId} not found!`);
			return;
		}
		let eventId = "";
		if (p.data.appId) {
			eventId = await chan.sendMessage({
				text: "Please enable blocks...",
				blocks: [{
					type: "image",
					title: {
						type: "plain_text",
						text: data.filename,
					},
					image_url: data.url,
					alt_text: data.filename,
				}],
			}, {
				asUser: false,
				username: asUser.displayname,
				iconUrl: asUser.avatarUrl,
			});
		} else if (asUser) {
			eventId = await chan.sendMessage({
				text: "Please enable blocks...",
				blocks: [{
					type: "image",
					title: {
						type: "plain_text",
						text: `${asUser.displayname} just uploaded an image, ${data.filename}`,
					},
					image_url: data.url,
					alt_text: data.filename,
				}],
			}, {
				asUser: true,
			});
		}
		if (eventId) {
			await this.puppet.eventSync.insert(room, data.eventId!, eventId);
		}
	}

	public async handleMatrixFile(
		room: IRemoteRoom,
		data: IFileEvent,
		asUser: ISendingUser | null,
		event: any,
	) {
		const p = this.puppets[room.puppetId];
		if (!p) {
			return;
		}
		const chan = p.client.getChannel(room.roomId);
		if (!chan) {
			log.warn(`Room ${room.roomId} not found!`);
			return;
		}
		const dedupeKey = `${room.puppetId};${room.roomId}`;
		this.messageDeduplicator.lock(dedupeKey, p.data.self.id, "file:" + data.filename);
		let eventId = "";
		if (asUser && p.data.appId) {
			eventId = await chan.sendMessage(`Uploaded a file: <${data.url}|${data.filename}>`, {
				asUser: false,
				username: asUser.displayname,
				iconUrl: asUser.avatarUrl,
			});
		} else if (asUser) {
			eventId = await chan.sendMessage(`${asUser.displayname} uploaded a file: <${data.url}|${data.filename}>`, {
				asUser: true,
			});
		} else {
			eventId = await chan.sendFile(data.url, data.filename);
		}
		this.messageDeduplicator.unlock(dedupeKey, p.data.self.id, eventId);
		if (eventId) {
			await this.puppet.eventSync.insert(room, data.eventId!, eventId);
		}
	}

	public async createRoom(room: IRemoteRoom): Promise<IRemoteRoom | null> {
		const p = this.puppets[room.puppetId];
		if (!p) {
			return null;
		}
		log.info(`Received create request for channel update puppetId=${room.puppetId} roomId=${room.roomId}`);
		const chan = p.client.getChannel(room.roomId);
		if (!chan) {
			return null;
		}
		return await this.getRoomParams(room.puppetId, chan);
	}

	public async createUser(remoteUser: IRemoteUser): Promise<IRemoteUser | null> {
		const p = this.puppets[remoteUser.puppetId];
		if (!p) {
			return null;
		}
		log.info(`Received create request for user update puppetId=${remoteUser.puppetId} userId=${remoteUser.userId}`);
		const user = p.client.getUser(remoteUser.userId);
		if (!user) {
			return null;
		}
		return await this.getUserParams(remoteUser.puppetId, user);
	}

	public async createGroup(remoteGroup: IRemoteGroup): Promise<IRemoteGroup | null> {
		const p = this.puppets[remoteGroup.puppetId];
		if (!p) {
			return null;
		}
		log.info(`Received create request for group puppetId=${remoteGroup.puppetId} groupId=${remoteGroup.groupId}`);
		const group = p.client.teams.get(remoteGroup.groupId);
		if (!group) {
			return null;
		}
		return await this.getGroupParams(remoteGroup.puppetId, group);
	}

	public async getDmRoom(remoteUser: IRemoteUser): Promise<string | null> {
		const p = this.puppets[remoteUser.puppetId];
		if (!p) {
			return null;
		}
		const user = p.client.getUser(remoteUser.userId);
		if (!user) {
			return null;
		}
		const chan = await user.im();
		return chan ? chan.fullId : null;
	}

	public async listUsers(puppetId: number): Promise<IRetList[]> {
		const p = this.puppets[puppetId];
		if (!p) {
			return [];
		}
		const reply: IRetList[] = [];
		for (const [, team] of p.client.teams) {
			if (team.partial) {
				await team.load();
			}
			reply.push({
				category: true,
				name: team.name,
			});
			for (const [, user] of team.users) {
				reply.push({
					id: user.fullId,
					name: user.displayName,
				});
			}
		}
		return reply;
	}

	public async listRooms(puppetId: number): Promise<IRetList[]> {
		const p = this.puppets[puppetId];
		if (!p) {
			return [];
		}
		const reply: IRetList[] = [];
		for (const [, team] of p.client.teams) {
			if (team.partial) {
				await team.load();
			}
			reply.push({
				category: true,
				name: team.name,
			});
			for (const [, chan] of team.channels) {
				if (chan.type !== "im") {
					reply.push({
						id: chan.fullId,
						name: chan.name || chan.fullId,
					});
				}
			}
		}
		return reply;
	}

	public async listGroups(puppetId: number): Promise<IRetList[]> {
		const p = this.puppets[puppetId];
		if (!p) {
			return [];
		}
		const reply: IRetList[] = [];
		for (const [, team] of p.client.teams) {
			if (team.partial) {
				await team.load();
			}
			reply.push({
				name: team.name,
				id: team.id,
			});
		}
		return reply;
	}

	public async getUserIdsInRoom(room: IRemoteRoom): Promise<Set<string> | null> {
		const p = this.puppets[room.puppetId];
		if (!p) {
			return null;
		}
		const chan = p.client.getChannel(room.roomId);
		if (!chan) {
			return null;
		}
		const users = new Set<string>();
		if (chan.partial) {
			await chan.load();
		}
		for (const [, member] of chan.members) {
			users.add(member.fullId);
		}
		return users;
	}

	private getMatrixMessageParserOpts(puppetId: number): IMatrixMessageParserOpts {
		const client = this.puppets[puppetId].client;
		return {
			callbacks: {
				canNotifyRoom: async () => true,
				getUserId: async (mxid: string) => {
					const parts = this.puppet.userSync.getPartsFromMxid(mxid);
					if (!parts || (parts.puppetId !== puppetId && parts.puppetId !== -1)) {
						return null;
					}
					return parts.userId.split("-")[1] || null;
				},
				getChannelId: async (mxid: string) => {
					const parts = await this.puppet.roomSync.getPartsFromMxid(mxid);
					if (!parts || (parts.puppetId !== puppetId && parts.puppetId !== -1)) {
						return null;
					}
					return parts.roomId.split("-")[1] || null;
				},
				mxcUrlToHttp: (mxc: string) => this.puppet.getUrlFromMxc(mxc),
			},
		};
	}

	private getSlackMessageParserOpts(puppetId: number, team: Slack.Team): ISlackMessageParserOpts {
		const client = this.puppets[puppetId].client;
		return {
			callbacks: {
				getUser: async (id: string, name: string) => {
					const user = client.getUser(id, team.id);
					if (!user) {
						return null;
					}
					return {
						mxid: await this.puppet.getMxidForUser({
							puppetId,
							userId: user.fullId,
						}),
						name: user.name,
					};
				},
				getChannel: async (id: string, name: string) => {
					const chan = client.getChannel(id, team.id);
					if (!chan) {
						return null;
					}
					return {
						mxid: await this.puppet.getMxidForRoom({
							puppetId,
							roomId: chan.fullId,
						}),
						name: "#" + chan.name,
					};
				},
				getUsergroup: async (id: string, name: string) => null,
				getTeam: async (id: string, name: string) => null,
				urlToMxc: async (url: string) => {
					try {
						return await this.puppet.uploadContent(null, url);
					} catch (err) {
						log.error("Error uploading file:", err.error || err.body || err);
					}
					return null;
				},
			},
		};
	}
}
