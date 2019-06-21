import {
	PuppetBridge,
	Log,
	IReceiveParams,
	IRemoteChanSend,
	IMessageEvent,
} from "mx-puppet-bridge";
import { RTMClient } from "@slack/rtm-api";
import { WebClient } from "@slack/web-api";

const log = new Log("SlackPuppet:slack");

interface ISlackPuppets {
	[puppetId: number]: {
		rtm: RTMClient;
		web: WebClient;
		data: any;
	}
}

export class Slack {
	private puppets: ISlackPuppets = {};
	constructor(
		private puppet: PuppetBridge,
	) { }

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
		const rtm = new RTMClient(data.token);
		const web = new WebClient(data.token);
		rtm.on("message", async (data) => {
			log.verbose("Got new message event");
			const params = this.getSendParams(puppetId, data);
			this.puppet.sendMessage(params, data.text);
		});
		rtm.start();
		this.puppets[puppetId] = {
			rtm,
			web,
			data,
		} as any;//ISlackPuppets;
	}

	public async handleMatrixMessage(room: IRemoteChanSend, data: IMessageEvent, event: any) {
		if (!this.puppets[room.puppetId]) {
			return;
		}
		await this.puppets[room.puppetId].rtm.sendMessage(data.body, room.roomId);
	}
}
