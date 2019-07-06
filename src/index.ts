import {
	PuppetBridge,
	IPuppetBridgeFeatures,
	IPuppetBridgeRegOpts,
	Log,
	IRetData,
} from "mx-puppet-bridge";
import * as commandLineArgs from "command-line-args";
import * as commandLineUsage from "command-line-usage";
import { Slack } from "./slack";
import * as escapeHtml from "escape-html";

const log = new Log("SlackPuppet:index");

const commandOptions = [
	{ name: "register", alias: "r", type: Boolean },
	{ name: "registration-file", alias: "f", type: String },
	{ name: "config", alias: "c", type: String },
	{ name: "help", alias: "h", type: Boolean },
];
const options = Object.assign({
	"register": false,
	"registration-file": "slack-registration.yaml",
	"config": "config.yaml",
	"help": false,
}, commandLineArgs(commandOptions));

if (options.help) {
	// tslint:disable-next-line:no-console
	console.log(commandLineUsage([
		{
			header: "Matrix Slack Puppet Bridge",
			content: "A matrix puppet bridge for slack",
		},
		{
			header: "Options",
			optionList: commandOptions,
		},
	]));
	process.exit(0);
}

const features = {
	file: true, // no need for the others as we auto-detect types anyways
	presence: true,
	typingTimeout: 5500,
	edit: true,
	reply: true,
} as IPuppetBridgeFeatures;

const puppet = new PuppetBridge(options["registration-file"], options.config, features);

if (options.register) {
	// okay, all we have to do is generate a registration file
	puppet.readConfig();
	try {
		puppet.generateRegistration({
			prefix: "_slackpuppet_",
			id: "slack-puppet",
			url: `http://${puppet.Config.bridge.bindAddress}:${puppet.Config.bridge.port}`,
		} as IPuppetBridgeRegOpts);
	} catch (err) {
		// tslint:disable-next-line:no-console
		console.log("Couldn't generate registration file:", err);
	}
	process.exit(0);
}

async function run() {
	await puppet.init();
	const slack = new Slack(puppet);
	puppet.on("puppetNew", slack.newPuppet.bind(slack));
	puppet.on("puppetDelete", slack.deletePuppet.bind(slack));
	puppet.on("message", slack.handleMatrixMessage.bind(slack));
	puppet.on("edit", slack.handleMatrixEdit.bind(slack));
	puppet.on("reply", slack.handleMatrixReply.bind(slack));
	puppet.on("redact", slack.handleMatrixRedact.bind(slack));
	puppet.on("file", slack.handleMatrixFile.bind(slack));
	puppet.setCreateChanHook(slack.createChan.bind(slack));
	puppet.setCreateUserHook(slack.createUser.bind(slack));
	puppet.setGetDmRoomIdHook(slack.getDmRoom.bind(slack));
	puppet.setListUsersHook(slack.listUsers.bind(slack));
	puppet.setListChansHook(slack.listChans.bind(slack));
	puppet.setGetDescHook(async (puppetId: number, data: any, html: boolean): Promise<string> => {
		let s = "Slack";
		if (data.team) {
			const name = data.team.name;
			if (html) {
				s += ` on <code>${escapeHtml(name)}</code>`;
			} else {
				s += ` on "${name}"`;
			}
		}
		if (data.self) {
			const name = data.self.name;
			if (html) {
				s += ` as <code>${escapeHtml(name)}`;
			} else {
				s += ` as "${name}"`;
			}
		}
		return s;
	});
	puppet.setGetDastaFromStrHook(async (str: string): Promise<IRetData> => {
		const retData = {
			success: false,
		} as IRetData;
		if (!str) {
			retData.error = "Please specify a token to link!";
			return retData;
		}
		retData.success = true;
		retData.data = {
			token: str.trim(),
		};
		return retData;
	});
	puppet.setBotHeaderMsgHook((): string => {
		return "Slack Puppet Bridge";
	});
	await puppet.start();
}

// tslint:disable-next-line:no-floating-promises
run(); // start the thing!
