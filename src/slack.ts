import {
	PuppetBridge,
	Log,
	IReceiveParams,
	IRemoteChanSend,
	IMessageEvent,
	IRemoteUserReceive,
} from "mx-puppet-bridge";
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
		return {
			userId: user.id,
			avatarUrl: user.profile.image_original,
			name: user.profile.display_name,
		} as IRemoteUserReceive;
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

	public async addPuppet(puppetId: number, data: any) {
		log.info(`Adding new Puppet: puppetId=${puppetId}`);
		if (this.puppets[puppetId]) {
			await this.removePuppet(puppetId);
		}
		const client = new Client(data.token);
		client.on("message", async (data) => {
			log.verbose("Got new message event");
			const params = this.getSendParams(puppetId, data);
			await this.puppet.sendMessage(params, data.text);
		});
		for (const ev of ["addUser", "updateUser", "updateBot"]) {
			client.on(ev, async (user) => {
				await this.puppet.updateUser(this.getUserParams(user));
			});
		}
		this.puppets[puppetId] = {
			client,
			data,
		} as any;//ISlackPuppets;
		await client.connect();
	}

	public async handleMatrixMessage(room: IRemoteChanSend, data: IMessageEvent, event: any) {
		if (!this.puppets[room.puppetId]) {
			return;
		}
		await this.puppets[room.puppetId].client.sendMessage(data.body, room.roomId);
	}
}
