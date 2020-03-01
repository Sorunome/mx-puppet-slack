import {
	PuppetBridge,
	Log,
	IReceiveParams,
	IMessageEvent,
	IRemoteUser,
	IRemoteRoom,
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
import { Client } from "./client";
import * as Emoji from "node-emoji";
import { SlackProvisioningAPI } from "./api";

const log = new Log("SlackPuppet:slack");

interface ISlackPuppet {
	client: Client;
	data: any;
	clientStopped: boolean;
}

interface ISlackPuppets {
	[puppetId: number]: ISlackPuppet;
}

export class Slack {
	private puppets: ISlackPuppets = {};
	private tsThreads: {[ts: string]: string} = {};
	private threadSendTs: {[ts: string]: string} = {};
	private slackMessageParser: SlackMessageParser;
	private matrixMessageParser: MatrixMessageParser;
	private messageDeduplicator: MessageDeduplicator;
	private provisioningAPI: SlackProvisioningAPI;
	constructor(
		private puppet: PuppetBridge,
	) {
		this.slackMessageParser = new SlackMessageParser();
		this.matrixMessageParser = new MatrixMessageParser();
		this.messageDeduplicator = new MessageDeduplicator();
		this.provisioningAPI = new SlackProvisioningAPI(puppet);
	}

	public async getUserParams(puppetId: number, user: any): Promise<IRemoteUser> {
		const nameVars = {} as IStringFormatterVars;
		const p = this.puppets[puppetId];
		if (p && p.data.team) {
			const team = await p.client.getTeamById(p.data.team.id);
			if (team) {
				nameVars.team = team.name;
			}
		}
		// check if we have a user
		if (user.profile) {
			// get the rigth avatar url
			const imageKey = this.getImageKeyFromObject(user.profile);
			let avatarUrl = "";
			if (imageKey) {
				avatarUrl = user.profile[imageKey];
			}
			log.verbose(`Determined avatar url ${imageKey}`);
			nameVars.name = user.profile.display_name || user.profile.real_name || user.real_name || user.name;
			return {
				puppetId,
				userId: user.id,
				avatarUrl,
				nameVars,
			} as IRemoteUser;
		} else {
			// okay, we have a bot
			const imageKey = this.getImageKeyFromObject(user.icons);
			let avatarUrl = "";
			if (imageKey) {
				avatarUrl = user.icons[imageKey];
			}
			log.verbose(`Determined avatar url ${imageKey}`);
			nameVars.name = user.name;
			return {
				puppetId,
				userId: user.id,
				avatarUrl,
				nameVars,
			} as IRemoteUser;
		}
	}

	public async getRoomParams(puppetId: number, chan: any): Promise<IRemoteRoom> {
		if (chan.is_im) {
			return {
				puppetId,
				roomId: chan.id,
				isDirect: true,
			} as IRemoteRoom;
		}
		const p = this.puppets[puppetId];
		let avatarUrl = "";
		const nameVars = {
			name: chan.name,
		} as IStringFormatterVars;
		if (p && p.data.team) {
			const team = await p.client.getTeamById(p.data.team.id);
			if (team) {
				const imageKey = this.getImageKeyFromObject(team.icon);
				if (imageKey) {
					avatarUrl = team.icon[imageKey];
				}
				nameVars.team = team.name;
			}
		}
		return {
			puppetId,
			roomId: chan.id,
			nameVars,
			avatarUrl,
			topic: chan.topic ? chan.topic.value : "",
			isDirect: false,
		} as IRemoteRoom;
	}

	public getSendParams(puppetId: number, data: any): IReceiveParams {
		let userId = data.user || data.bot_id;
		let eventId = data.ts;
		let externalUrl: string | undefined;
		for (const tryKey of ["message", "previous_message"]) {
			if (data[tryKey]) {
				if (!userId) {
					userId = data[tryKey].user || data[tryKey].bot_id;
				}
				if (!eventId) {
					eventId = data[tryKey].ts;
				}
			}
		}
		const roomId = data.channel || data.item.channel;
		log.silly(`Generating send params roomId=${roomId} userId=${userId} puppetId=${puppetId}`);
		log.silly(data);
		const p = this.puppets[puppetId];
		if (p) {
			externalUrl = `https://${p.data.team.domain}.slack.com/archives/${roomId}/p${eventId}`;
		}
		return {
			room: {
				roomId,
				puppetId,
			},
			eventId,
			externalUrl,
			user: {
				userId,
				puppetId,
			},
		} as IReceiveParams;
	}

	public async removePuppet(puppetId: number) {
		log.info(`Removing puppet: puppetId=${puppetId}`);
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
		const client = new Client(p.data.token, p.data.cookie || null);
		client.on("connected", async () => {
			await this.puppet.sendStatusMessage(puppetId, "connected");
		});
		client.on("authenticated", async (data) => {
			const d = this.puppets[puppetId].data;
			if (!d.team) {
				d.team = data.team;
			} else {
				Object.assign(d.team, data.team);
			}
			if (!d.self) {
				d.self = data.self;
			} else {
				Object.assign(d.self, data.self);
			}
			await this.puppet.setUserId(puppetId, data.self.id);
			await this.puppet.setPuppetData(puppetId, d);
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
				await this.startClient(puppetId);
			} catch (err) {
				log.warn("Failed to restart client", err);
			}
		});
		client.on("message", async (data) => {
			try {
				log.verbose("Got new message event");
				await this.handleSlackMessage(puppetId, data);
			} catch (err) {
				log.error("Error handling slack message event", err);
			}
		});
		for (const ev of ["addUser", "updateUser", "updateBot"]) {
			client.on(ev, async (user) => {
				await this.puppet.updateUser(await this.getUserParams(puppetId, user));
			});
		}
		for (const ev of ["addChannel", "updateChannel"]) {
			client.on(ev, async (chan) => {
				log.verbose("Received slack event to update channel:", ev);
				await this.puppet.updateRoom(await this.getRoomParams(puppetId, chan));
			});
		}
		client.on("typing", async (data, isTyping) => {
			const params = this.getSendParams(puppetId, data);
			await this.puppet.setUserTyping(params, isTyping);
		});
		client.on("presence", async (data) => {
			log.verbose("Received presence change", data);
			if (!data.users) {
				data.users = [];
			}
			if (data.user) {
				data.users.push(data.user);
			}
			for (const user of data.users) {
				let matrixPresence = {
					active: "online",
					away: "offline",
				}[data.presence];
				if (!matrixPresence) {
					matrixPresence = "offline";
				}
				await this.puppet.setUserPresence({
					userId: user,
					puppetId,
				}, matrixPresence);
			}
		});
		client.on("reaction_added", async (data) => {
			log.verbose("Received new reaction", data);
			const params = this.getSendParams(puppetId, data);
			const e = Emoji.get(data.reaction);
			if (!e) {
				return;
			}
			await this.puppet.sendReaction(params, data.item.ts, e);
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
		const client = new Client(data.token);
		this.puppets[puppetId] = {
			client,
			data,
			clientStopped: false,
		} as ISlackPuppet;
		await this.startClient(puppetId);
	}

	public async deletePuppet(puppetId: number) {
		log.info(`Got signal to quit Puppet: puppetId=${puppetId}`);
		await this.stopClient(puppetId);
		await this.removePuppet(puppetId);
	}

	public async handleSlackMessage(puppetId: number, data: any) {
		const params = this.getSendParams(puppetId, data);
		const client = this.puppets[puppetId].client;
		const parserOpts = {
			callbacks: {
				getUser: async (id: string, name: string) => {
					const user = await client.getUserById(id);
					if (!user) {
						return null;
					}
					return {
						mxid: await this.puppet.getMxidForUser({
							puppetId,
							userId: id,
						}),
						name: user.name,
					};
				},
				getChannel: async (id: string, name: string) => {
					const chan = await client.getChannelById(id);
					if (!chan) {
						return null;
					}
					return {
						mxid: await this.puppet.getMxidForRoom({
							puppetId,
							roomId: id,
						}),
						name: "#" + chan.name,
					};
				},
				getUsergroup: async (id: string, name: string) => null,
				getTeam: async (id: string, name: string) => null,
				urlToMxc: async (url: string) => {
					try {
						return await this.puppet.uploadContent(this.puppet.AS.botIntent.underlyingClient, url);
					} catch (err) {
						log.error("Error uploading file:", err.error || err.body || err);
					}
					return null;
				},
			},
		} as ISlackMessageParserOpts;
		log.verbose(`Received message. subtype=${data.subtype} files=${data.files ? data.files.length : 0}`);
		const dedupeKey = `${puppetId};${params.room.roomId}`;
		if (data.subtype === "channel_join") {
			return; // we don't handle those
		}
		if (data.subtype === "message_changed") {
			if (data.message.text === data.previous_message.text ||
				await this.messageDeduplicator.dedupe(dedupeKey, params.user.userId, params.eventId, data.message.text)) {
				// nothing to do
				return;
			}
			const res = await this.slackMessageParser.FormatMessage(parserOpts, data.message);
			await this.puppet.sendEdit(params, data.previous_message.ts, {
				body: res.body,
				formattedBody: res.formatted_body,
			});
			return;
		}
		if (data.subtype === "message_deleted") {
			await this.puppet.sendRedact(params, data.previous_message.ts);
			return;
		}
		if (data.subtype === "message_replied" && !data.files) {
			return;
		}
		if ((data.text || (data.attachments && data.attachments.length > 0) || (data.blocks && data.blocks.length > 0)) && !(
			await this.messageDeduplicator.dedupe(dedupeKey, params.user.userId, params.eventId, data.text)
		)) {
			// send a normal message, if present
			const res = await this.slackMessageParser.FormatMessage(parserOpts, data);
			const opts = {
				body: res.body,
				formattedBody: res.formatted_body,
				emote: data.subtype === "me_message",
			};
			if (data.thread_ts) {
				const replyTs = this.threadSendTs[data.thread_ts] || data.thread_ts;
				this.threadSendTs[data.thread_ts] = data.ts;
				await this.puppet.sendReply(params, replyTs, opts);
			} else {
				await this.puppet.sendMessage(params, opts);
			}
		}
		if (data.files) {
			// this has files
			for (const f of data.files) {
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

	public async handleMatrixMessage(room: IRemoteRoom, data: IMessageEvent, asUser: ISendingUser | null, event: any) {
		const p = this.puppets[room.puppetId];
		if (!p) {
			return;
		}
		const msg = await this.matrixMessageParser.FormatMessage(
			this.getMatrixMessageParserOpts(room.puppetId),
			event.content,
		);
		const dedupeKey = `${room.puppetId};${room.roomId}`;
		this.messageDeduplicator.lock(dedupeKey, p.data.self.id, msg.text);
		let eventId = "";
		if (data.emote) {
			eventId = await p.client.sendMeMessage(msg, room.roomId);
		} else {
			eventId = await p.client.sendMessage(msg, room.roomId);
		}
		this.messageDeduplicator.unlock(dedupeKey, p.data.self.id, eventId);
		if (eventId) {
			await this.puppet.eventStore.insert(room.puppetId, data.eventId!, eventId);
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
		const msg = await this.matrixMessageParser.FormatMessage(
			this.getMatrixMessageParserOpts(room.puppetId),
			event.content["m.new_content"],
		);
		const dedupeKey = `${room.puppetId};${room.roomId}`;
		this.messageDeduplicator.lock(dedupeKey, p.data.self.id, msg.text);
		const newEventId = await p.client.editMessage(msg, room.roomId, eventId);
		this.messageDeduplicator.unlock(dedupeKey, p.data.self.id, newEventId);
		if (newEventId) {
			await this.puppet.eventStore.insert(room.puppetId, data.eventId!, newEventId);
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
		let tsThread = eventId;
		while (this.tsThreads[tsThread]) {
			tsThread = this.tsThreads[tsThread];
		}
		log.verbose(`Determined thread ts=${tsThread}`);
		const msg = await this.matrixMessageParser.FormatMessage(
			this.getMatrixMessageParserOpts(room.puppetId),
			event.content,
		);
		const dedupeKey = `${room.puppetId};${room.roomId}`;
		this.messageDeduplicator.lock(dedupeKey, p.data.self.id, msg.text);
		const newEventId = await p.client.replyMessage(msg, room.roomId, tsThread);
		this.messageDeduplicator.unlock(dedupeKey, p.data.self.id, newEventId);
		if (newEventId) {
			this.tsThreads[newEventId] = tsThread;
			await this.puppet.eventStore.insert(room.puppetId, data.eventId!, newEventId);
		}
	}

	public async handleMatrixRedact(room: IRemoteRoom, eventId: string, asUser: ISendingUser | null, event: any) {
		const p = this.puppets[room.puppetId];
		if (!p) {
			return;
		}
		await p.client.deleteMessage(room.roomId, eventId);
	}

	public async handleMatrixReaction(room: IRemoteRoom, eventId: string, asUser: ISendingUser | null, reaction: string) {
		const p = this.puppets[room.puppetId];
		if (!p) {
			return;
		}
		const e = Emoji.find(reaction);
		if (!e) {
			return;
		}
		await p.client.sendReaction(room.roomId, eventId, e.key);
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
		const dedupeKey = `${room.puppetId};${room.roomId}`;
		this.messageDeduplicator.lock(dedupeKey, p.data.self.id, "file:" + data.filename);
		const eventId = await this.puppets[room.puppetId].client.sendFileMessage(data.url, data.filename, room.roomId);
		this.messageDeduplicator.unlock(dedupeKey, p.data.self.id, eventId);
		if (eventId) {
			await this.puppet.eventStore.insert(room.puppetId, data.eventId!, eventId);
		}
	}

	public async createRoom(oldChan: IRemoteRoom): Promise<IRemoteRoom | null> {
		const p = this.puppets[oldChan.puppetId];
		if (!p) {
			return null;
		}
		log.info(`Received create request for channel update puppetId=${oldChan.puppetId} roomId=${oldChan.roomId}`);
		const chan = await p.client.getRoomById(oldChan.roomId);
		if (!chan) {
			return null;
		}
		return await this.getRoomParams(oldChan.puppetId, chan);
	}

	public async createUser(oldUser: IRemoteUser): Promise<IRemoteUser | null> {
		const p = this.puppets[oldUser.puppetId];
		if (!p) {
			return null;
		}
		log.info(`Received create request for user update puppetId=${oldUser.puppetId} userId=${oldUser.userId}`);
		let user = await p.client.getUserById(oldUser.userId);
		if (!user) {
			user = await p.client.getBotById(oldUser.userId);
		}
		if (!user) {
			return null;
		}
		return await this.getUserParams(oldUser.puppetId, user);
	}

	public async getDmRoom(user: IRemoteUser): Promise<string | null> {
		const p = this.puppets[user.puppetId];
		if (!p) {
			return null;
		}
		const roomId = await p.client.getRoomForUser(user.userId);
		if (!roomId) {
			return null;
		}
		return roomId;
	}

	public async listUsers(puppetId: number): Promise<IRetList[]> {
		const p = this.puppets[puppetId];
		if (!p) {
			return [];
		}
		const reply: IRetList[] = [];
		const users = await p.client.listUsers();
		for (const u of users) {
			reply.push({
				id: u.id,
				name: u.profile ? u.profile.display_name : u.name,
			});
		}
		return reply;
	}

	public async listRooms(puppetId: number): Promise<IRetList[]> {
		const p = this.puppets[puppetId];
		if (!p) {
			return [];
		}
		const reply: IRetList[] = [];
		const channels = await p.client.listChannels();
		for (const c of channels) {
			reply.push({
				id: c.id,
				name: c.name,
			});
		}
		return reply;
	}

	private getMatrixMessageParserOpts(puppetId: number): IMatrixMessageParserOpts {
		const client = this.puppets[puppetId].client;
		return {
			callbacks: {
				canNotifyRoom: async () => true,
				getUserId: async (mxid: string) => {
					const parts = this.puppet.userSync.getPartsFromMxid(mxid);
					if (!parts || parts.puppetId !== puppetId) {
						return null;
					}
					return parts.userId;
				},
				getChannelId: async (mxid: string) => {
					const parts = await this.puppet.roomSync.getPartsFromMxid(mxid);
					if (!parts || parts.puppetId !== puppetId) {
						return null;
					}
					return parts.roomId;
				},
				mxcUrlToHttp: (mxc: string) => this.puppet.getUrlFromMxc(mxc),
			},
		};
	}

	private getImageKeyFromObject(o: any): string | undefined {
		if (!o) {
			return undefined;
		}
		return Object.keys(o).filter((el) => {
			return el.startsWith("image_");
		}).sort((e1, e2) => {
			const n1 = e1.substring("image_".length);
			const n2 = e2.substring("image_".length);
			// we want to sort "original" to the top
			if (n1 === "original") {
				return -1;
			}
			if (n2 === "original") {
				return 1;
			}
			// buuut everything else to the bottom
			const nn1 = Number(n1);
			const nn2 = Number(n2);
			if (isNaN(nn1)) {
				return 1;
			}
			if (isNaN(nn2)) {
				return -1;
			}
			return nn2 - nn1;
		})[0];
	}
}
