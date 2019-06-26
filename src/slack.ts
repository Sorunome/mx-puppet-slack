import {
	PuppetBridge,
	Log,
	IReceiveParams,
	IRemoteChanSend,
	IMessageEvent,
	IRemoteUserReceive,
	IRemoteChanReceive,
	ISendMessageOpts,
	IFileEvent,
	Util,
} from "mx-puppet-bridge";
import { SlackMessageParser, ISlackMessageParserOpts } from "./slackmessageparser";
import { Client } from "./client";
import { MatrixMessageProcessor, IMatrixMessageParserOpts } from "./matrixmessageprocessor";

const log = new Log("SlackPuppet:slack");

interface ISlackPuppets {
	[puppetId: number]: {
		client: Client;
		data: any;
		clientStopped: boolean;
	}
}

export class Slack {
	private puppets: ISlackPuppets = {};
	constructor(
		private puppet: PuppetBridge,
	) { }

	public getUserParams(puppetId: number, user: any): IRemoteUserReceive {
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
			} as IRemoteUserReceive;
		}
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
		} as IRemoteUserReceive;
	}

	public async getChannelParams(puppetId: number, chan: any): IRemoteChanReceive {
		if (chan.is_im) {
			return {
				puppetId,
				roomId: chan.id,
				isDirect: true,
			} as IRemoteChanReceive;
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
		} as IRemoteChanReceive;
	}

	public getSendParams(puppetId: number, data: any): IReceiveParams {
		return {
			chan: {
				roomId: data.channel,
				puppetId,
			},
			user: {
				userId: data.user || data.bot_id,
				puppetId
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
			await Util.sleep(60 * 1000);
			try {
				await this.startClient(puppetId);
			} catch (err) {
				log.warn("Failed to restart client", err);
			}
		})
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
		} as any;//ISlackPuppets;
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
		if (data.subtype === "message_changed") {
			if (data.message.text === data.previous_message.text) {
				// nothing to do
				return;
			}
			const { msg, html } = await SlackMessageParser.parse(parserOpts, `Edit: ${data.message.text}`);
			await this.puppet.sendMessage(params, {
				body: msg,
				formatted_body: html,
			});
			return;
		}
		if (data.text) {
			// send a normal message, if present
			const { msg, html } = await SlackMessageParser.parse(parserOpts, data.text, data.attachments);
			await this.puppet.sendMessage(params, {
				body: msg,
				formatted_body: html,
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
						action: true,
					});
				}
				if (f.initial_comment) {
					const { msg, html } = await SlackMessageParser.parse(parserOpts, f.initial_comment);
					await this.puppet.sendMessage(params, {
						body: msg,
						formatted_body: html,
					});
				}
			}
		}
	}

	public async handleMatrixMessage(room: IRemoteChanSend, data: IMessageEvent, event: any) {
		const p = this.puppets[room.puppetId];
		if (!p) {
			return;
		}
		const msg = await MatrixMessageProcessor.parse({}, data);
		if (data.emote) {
			await p.client.sendMessage(`_${msg}_`, room.roomId);
		} else {
			await p.client.sendMessage(msg, room.roomId);
		}
	}

	public async handleMatrixFile(room: IRemoteChanSend, data: IFileEvent, event: any) {
		if (!this.puppets[room.puppetId]) {
			return;
		}
		await this.puppets[room.puppetId].client.sendFileMessage(data.url, data.filename, room.roomId);
	}

	public async createChan(puppetId: number, cid: string): Promise<IRemoteChanReceive | null> {
		const p = this.puppets[puppetId];
		if (!p) {
			return null;
		}
		log.info(`Received create request for channel update puppetId=${puppetId} cid=${cid}`);
		let chan = await p.client.getRoomById(cid);
		if (!chan) {
			return null;
		}
		return await this.getChannelParams(puppetId, chan);
	}

	public async createUser(puppetId: number, uid: string): Promise<IRemoteUserReceive | null> {
		const p = this.puppets[puppetId];
		if (!p) {
			return null;
		}
		log.info(`Received create request for user update puppetId=${puppetId} uid=${uid}`);
		let user = await p.client.getUserById(uid);
		if (!user) {
			user = await p.client.getBotById(uid);
		}
		if (!user) {
			return null;
		}
		return this.getUserParams(puppetId, user);
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
