import {
	PuppetBridge,
	IProtocolInformation,
	IPuppetBridgeRegOpts,
	Log,
} from "mx-puppet-bridge";
import * as commandLineArgs from "command-line-args";
import * as commandLineUsage from "command-line-usage";
import { Slack } from "./slack";
import { SlackConfigWrap } from "./config";
import * as fs from "fs";
import * as yaml from "js-yaml";
import { oauthCallback, getDataFromStrHook } from "./oauth";

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

const protocol = {
	features: {
		file: true, // no need for the others as we auto-detect types anyways
		presence: true,
		typingTimeout: 5500,
		edit: true,
		reply: true,
	},
	id: "slack",
	displayname: "Slack",
	externalUrl: "https://slack.com",
	namePatterns: {
		user: ":name",
		room: ":name[:team? - :team,]",
		group: ":name",
	},
} as IProtocolInformation;

const puppet = new PuppetBridge(options["registration-file"], options.config, protocol);

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

let config: SlackConfigWrap = new SlackConfigWrap();

function readConfig() {
	config = new SlackConfigWrap();
	config.applyConfig(yaml.safeLoad(fs.readFileSync(options.config)));
}

export function Config(): SlackConfigWrap {
	return config;
}

async function run() {
	await puppet.init();
	readConfig();
	const slack = new Slack(puppet);
	puppet.on("puppetNew", slack.newPuppet.bind(slack));
	puppet.on("puppetDelete", slack.deletePuppet.bind(slack));
	puppet.on("message", slack.handleMatrixMessage.bind(slack));
	puppet.on("edit", slack.handleMatrixEdit.bind(slack));
	puppet.on("reply", slack.handleMatrixReply.bind(slack));
	puppet.on("redact", slack.handleMatrixRedact.bind(slack));
	puppet.on("reaction", slack.handleMatrixReaction.bind(slack));
	puppet.on("file", slack.handleMatrixFile.bind(slack));
	puppet.setCreateChanHook(slack.createChan.bind(slack));
	puppet.setCreateUserHook(slack.createUser.bind(slack));
	puppet.setGetDmRoomIdHook(slack.getDmRoom.bind(slack));
	puppet.setListUsersHook(slack.listUsers.bind(slack));
	puppet.setListChansHook(slack.listChans.bind(slack));
	puppet.setGetDescHook(async (puppetId: number, data: any): Promise<string> => {
		let s = "Slack";
		if (data.team) {
			s += ` on \`${data.team.name}\``;
		}
		if (data.self) {
			s += ` as \`${data.self.name}\``;
		}
		return s;
	});
	puppet.setGetDastaFromStrHook(getDataFromStrHook);
	puppet.setBotHeaderMsgHook((): string => {
		return "Slack Puppet Bridge";
	});
	await puppet.start();
	puppet.AS.expressAppInstance.get(config.oauth.redirectPath, oauthCallback);
}

// tslint:disable-next-line:no-floating-promises
run(); // start the thing!
