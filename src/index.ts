import {
	PuppetBridge,
	IPuppetBridgeFeatures,
	IPuppetBridgeRegOpts,
	Log,
} from "mx-puppet-bridge";
import * as commandLineArgs from "command-line-args";
import * as commandLineUsage from "command-line-usage";
import { Slack } from "./slack";

const log = new Log("SlackPuppet:index");

const commandOptions = [
	{ name: "register", alias: "r", type: Boolean },
	{ name: "registration-file", alias: "f", type: String },
	{ name: "config", alias: "c", type: String },
	{ name: "help", alias: "h", type: Boolean },
];
const options = Object.assign({
	register: false,
	"registration-file": "slack-registration.yaml",
	config: "config.yaml",
	help: false,
}, commandLineArgs(commandOptions));

if (options.help) {
	console.log(commandLineUsage([
		{
			header: "Matrix Slack Puppet Bridge",
			content: "A matrix puppet bridge for slack",
		},
		{
			header: "Options",
			optionList: commandOptions,
		}
	]));
	process.exit(0);
}

const features = {
	
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
		console.log("Couldn't generate registration file:", err);
	}
	process.exit(0);
}

async function run() {
	await puppet.init();
	const slack = new Slack(puppet);
	puppet.on("puppetAdd", slack.addPuppet.bind(slack));
	puppet.on("message", slack.handleMatrixMessage.bind(slack));
	puppet.on("updateChannel", slack.updateChannel.bind(slack));
	puppet.on("updateUser", slack.updateUser.bind(slack));
	await puppet.start();
}

run(); // start the thing!
