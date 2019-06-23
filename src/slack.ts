import {
	PuppetBridge,
	Log,
	IReceiveParams,
	IRemoteChanSend,
	IMessageEvent,
	IRemoteUserReceive,
	IRemoteChanReceive,
	ISendMessageOpts,
	Util,
} from "mx-puppet-bridge";
import { SlackMessageParser, ISlackMessageParserOpts } from "./slackmessageparser";
import { Client } from "./client";

const log = new Log("SlackPuppet:slack");

interface ISlackPuppets {
	[puppetId: number]: {
		client: Client;
		data: any;
	}
}

export class Slack {
	private puppets: ISlackPuppets = {};
	constructor(
		private puppet: PuppetBridge,
	) { }

	public getUserParams(user: any): IRemoteUserReceive {
		// get the rigth avatar url
		const imageKey = Object.keys(user.profile).filter((el) => {
			return el.startsWith("image_");
		}).sort((e1, e2) => {
			const n1 = Number(e1.substring("image_".length));
			const n2 = Number(e2.substring("image_".length));
			if (isNaN(n1)) {
				return -1;
			}
			if (isNaN(n2)) {
				return 1;
			}
			return n2 - n1;
		})[0];
		log.verbose(`Determined avatar url ${imageKey}`);
		return {
			userId: user.id,
			avatarUrl: user.profile[imageKey],
			name: user.profile.display_name,
		} as IRemoteUserReceive;
	}

	public getChannelParams(puppetId: number, chan: any): IRemoteChanReceive {
		if (chan.isDirect) {
			return {
				puppetId,
				roomId: chan.id,
				isDirect: true,
			} as IRemoteChanReceive;
		}
		return {
			puppetId,
			roomId: chan.id,
			name: chan.name,
			topic: chan.topic ? chan.topic.value : "",
			isDirect: false,
		} as IRemoteChanReceive;
	}

	public getSendParams(puppetId: number, data: any): IReceiveParams {
		return {
			chan: {
				roomId: data.channel,
				puppetId: puppetId,
			},
			user: {
				userId: data.user,
			},
		} as IReceiveParams;
	}

	public async removePuppet(puppetId: number) {
		log.info(`Removing puppet: puppetId=${puppetId}`);
		delete this.puppets[puppetId];
	}

	public async startClient(puppetId: number) {
		const p = this.puppets[puppetId];
		if (!p) {
			return;
		}
		const client = new Client(p.data.token);
		client.on("disconnected", async () => {
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
				await this.puppet.updateUser(this.getUserParams(user));
			});
		}
		for (const ev of ["addChannel", "updateChannel"]) {
			client.on(ev, async (chan) => {
				await this.puppet.updateChannel(this.getChannelParams(puppetId, chan));
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

	public async addPuppet(puppetId: number, data: any) {
		log.info(`Adding new Puppet: puppetId=${puppetId}`);
		if (this.puppets[puppetId]) {
			await this.removePuppet(puppetId);
		}
		const client = new Client(data.token);
		this.puppets[puppetId] = {
			client,
			data,
		} as any;//ISlackPuppets;
		await this.startClient(puppetId);
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
		if (!this.puppets[room.puppetId]) {
			return;
		}
		await this.puppets[room.puppetId].client.sendMessage(data.body, room.roomId);
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
		return this.getChannelParams(puppetId, chan);
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
		return this.getUserParams(user);
	}
}
