import {
	PuppetBridge,
	Log,
	IReceiveParams,
	IMessageEvent,
	IRemoteUser,
	IRemoteChan,
	IFileEvent,
	Util,
	IRetList,
} from "mx-puppet-bridge";
import { SlackMessageParser, ISlackMessageParserOpts } from "./slackmessageparser";
import { Client } from "./client";
import { MatrixMessageProcessor, IMatrixMessageParserOpts } from "./matrixmessageprocessor";

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
	constructor(
		private puppet: PuppetBridge,
	) { }

	public getUserParams(puppetId: number, user: any): IRemoteUser {
		// check if we have a user
		if (user.profile) {
			// get the rigth avatar url
			const imageKey = this.getImageKeyFromObject(user.profile);
			let avatarUrl = "";
			if (imageKey) {
				avatarUrl = user.profile[imageKey];
			}
			log.verbose(`Determined avatar url ${imageKey}`);
			return {
				puppetId,
				userId: user.id,
				avatarUrl,
				name: user.profile.display_name,
			} as IRemoteUser;
		} else {
			// okay, we have a bot
			const imageKey = this.getImageKeyFromObject(user.icons);
			let avatarUrl = "";
			if (imageKey) {
				avatarUrl = user.icons[imageKey];
			}
			log.verbose(`Determined avatar url ${imageKey}`);
			return {
				puppetId,
				userId: user.id,
				avatarUrl,
				name: user.name,
			} as IRemoteUser;
		}
	}

	public async getChannelParams(puppetId: number, chan: any): Promise<IRemoteChan> {
		if (chan.is_im) {
			return {
				puppetId,
				roomId: chan.id,
				isDirect: true,
			} as IRemoteChan;
		}
		const p = this.puppets[puppetId];
		let avatarUrl = "";
		let name = chan.name;
		if (p && p.data.team) {
			const team = await p.client.getTeamById(p.data.team.id);
			if (team) {
				const imageKey = this.getImageKeyFromObject(team.icon);
				if (imageKey) {
					avatarUrl = team.icon[imageKey];
				}
				name += ` - ${team.name}`;
			}
		}
		return {
			puppetId,
			roomId: chan.id,
			name,
			avatarUrl,
			topic: chan.topic ? chan.topic.value : "",
			isDirect: false,
		} as IRemoteChan;
	}

	public getSendParams(puppetId: number, data: any): IReceiveParams {
		let userId = data.user || data.bot_id;
		let eventId = data.ts;
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
		log.silly(`Generating send params roomId=${data.channel} userId=${userId} puppetId=${puppetId}`);
		log.silly(data);
		return {
			chan: {
				roomId: data.channel,
				puppetId,
			},
			eventId,
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
		const client = new Client(p.data.token);
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
			const MINUTE = 60000;
			await Util.sleep(MINUTE);
			try {
				await this.startClient(puppetId);
			} catch (err) {
				log.warn("Failed to restart client", err);
			}
		});
		client.on("message", async (data) => {
			log.verbose("Got new message event");
			await this.handleSlackMessage(puppetId, data);
		});
		for (const ev of ["addUser", "updateUser", "updateBot"]) {
			client.on(ev, async (user) => {
				await this.puppet.updateUser(this.getUserParams(puppetId, user));
			});
		}
		for (const ev of ["addChannel", "updateChannel"]) {
			client.on(ev, async (chan) => {
				log.verbose("Received slack event to update channel:", ev);
				await this.puppet.updateChannel(await this.getChannelParams(puppetId, chan));
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
		p.client = client;
		try {
			await client.connect();
		} catch (err) {
			log.warn("Failed to connect client", err);
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
			puppetId,
			puppet: this.puppet,
			client,
		} as ISlackMessageParserOpts;
		log.verbose(`Received message. subtype=${data.subtype} files=${data.files ? data.files.length : 0}`);
		log.silly(data);
		if (data.subtype === "message_changed") {
			if (data.message.text === data.previous_message.text || data.message.text.startsWith("\ufff0")) {
				// nothing to do
				return;
			}
			const { msg, html } = await SlackMessageParser.parse(parserOpts, data.message.text);
			await this.puppet.sendEdit(params, data.previous_message.ts, {
				body: msg,
				formattedBody: html,
			});
			return;
		}
		if (data.subtype === "message_deleted") {
			await this.puppet.sendRedact(params, data.previous_message.ts);
		}
		if (data.text && !data.text.startsWith("\ufff0")) {
			// send a normal message, if present
			const { msg, html } = await SlackMessageParser.parse(parserOpts, data.text, data.attachments);
			await this.puppet.sendMessage(params, {
				body: msg,
				formattedBody: html,
				emote: data.subtype === "me_message",
			});
		}
		if (data.files) {
			// this has files
			for (const f of data.files) {
				if (f.title && f.title.startsWith("\ufff0")) {
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
					const { msg, html } = await SlackMessageParser.parse(parserOpts, f.initial_comment);
					await this.puppet.sendMessage(params, {
						body: msg,
						formattedBody: html,
					});
				}
			}
		}
	}

	public async handleMatrixMessage(room: IRemoteChan, data: IMessageEvent, event: any) {
		const p = this.puppets[room.puppetId];
		if (!p) {
			return;
		}
		const msg = await MatrixMessageProcessor.parse({
			puppetId: room.puppetId,
			puppet: this.puppet,
		} as IMatrixMessageParserOpts, event.content);
		let eventId = "";
		if (data.emote) {
			eventId = await p.client.sendMeMessage(msg, room.roomId);
		} else {
			eventId = await p.client.sendMessage(msg, room.roomId);
		}
		if (eventId) {
			await this.puppet.eventStore.insert(room.puppetId, data.eventId!, eventId);
		}
	}

	public async handleMatrixEdit(room: IRemoteChan, eventId: string, data: IMessageEvent, event: any) {
		const p = this.puppets[room.puppetId];
		if (!p) {
			return;
		}
		const msg = await MatrixMessageProcessor.parse({
			puppetId: room.puppetId,
			puppet: this.puppet,
		} as IMatrixMessageParserOpts, event.content["m.new_content"]);
		const newEventId = await p.client.editMessage(msg, room.roomId, eventId);
		if (newEventId) {
			await this.puppet.eventStore.insert(room.puppetId, data.eventId!, newEventId);
		}
	}

	public async handleMatrixRedact(room: IRemoteChan, eventId: string, event: any) {
		const p = this.puppets[room.puppetId];
		if (!p) {
			return;
		}
		await p.client.deleteMessage(room.roomId, eventId);
	}

	public async handleMatrixFile(room: IRemoteChan, data: IFileEvent, event: any) {
		if (!this.puppets[room.puppetId]) {
			return;
		}
		const eventId = await this.puppets[room.puppetId].client.sendFileMessage(data.url, data.filename, room.roomId);
		if (eventId) {
			await this.puppet.eventStore.insert(room.puppetId, data.eventId!, eventId);
		}
	}

	public async createChan(oldChan: IRemoteChan): Promise<IRemoteChan | null> {
		const p = this.puppets[oldChan.puppetId];
		if (!p) {
			return null;
		}
		log.info(`Received create request for channel update puppetId=${oldChan.puppetId} roomId=${oldChan.roomId}`);
		const chan = await p.client.getRoomById(oldChan.roomId);
		if (!chan) {
			return null;
		}
		return await this.getChannelParams(oldChan.puppetId, chan);
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
		return this.getUserParams(oldUser.puppetId, user);
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

	public async listChans(puppetId: number): Promise<IRetList[]> {
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
