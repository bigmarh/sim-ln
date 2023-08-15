#! /usr/bin/env node


import LndGrpc from 'lnd-grpc';
import fs from 'fs';
import { program } from 'commander';
import { select, input, confirm } from '@inquirer/prompts';
import { v4 } from 'uuid';
import { parse } from 'json2csv';
import { getFrequency, getAmountInSats } from './validation/inputGetters.js';
program.requiredOption('--config <file>');
program.option('--csv');
program.parse();

const options = program.opts();
const configFile = options.config;

// Blocking example with fs.readFileSync
const fileName = configFile;
const config = JSON.parse(fs.readFileSync(fileName, 'utf-8'));
let nodeObj = {};
const controlNodes = config.nodes.map(node => node);



console.log('Setting up Control Nodes...', config.nodes.length)
async function buildControlNodes() {
    if (!controlNodes.length) return promptForActivities();

    let node = controlNodes.shift()
    const grpc = new LndGrpc({
        host: node.ip,
        cert: node.cert,
        macaroon: node.macaroon,
    })

    grpc.connect();
    (async function() {

        const { WalletUnlocker, Lightning } = grpc.services
        // Do something cool if we detect that the wallet is locked.
        grpc.on(`connected`, () => console.log('wallet connected!'))
        // Do something cool if we detect that the wallet is locked.
        grpc.on(`locked`, async () => {
            await grpc.activateLightning()
        })

        // Do something cool when the wallet gets unlocked.
        grpc.on(`active`, async () => {
            const current_node = await Lightning.getInfo();
            const nodeGraph = await Lightning.describeGraph()
            console.log(nodeGraph);

            if (nodeGraph.nodes < 1) {
                console.log(`Node: ${node.alias} has no graph`)
                return console.error("Please check that controlled nodes have open channels to other nodes")
            }
            //dump graph information
            nodeObj[current_node.identity_pubkey] = current_node;
            nodeObj[current_node.identity_pubkey].graph = nodeGraph;
            node.id = current_node.identity_pubkey;
            
            //create array of possible destintations for node
            nodeObj[current_node.identity_pubkey].possible_dests = nodeGraph.nodes.filter((n) => {
                return n.pub_key != current_node.identity_pubkey
            })
            grpc.disconnect()
        })
        // Do something cool when the connection gets disconnected.
        grpc.on(`disconnected`, () => {

            console.log(config.nodes.length);
            if (Object.keys(nodeObj).length == config.nodes.length) promptForActivities();
            else buildControlNodes();
        })


    })()

}

buildControlNodes();

let activities = [];
async function promptForActivities() {

    console.log("\nCreate a New Activity");
    console.log("_________________________________\n");
    let activity = {};
    activity.uuid = v4();

    activity.src = await select({
        message: "Choose a source? \n",
        choices: Object.keys(nodeObj).map(key => {
            let node = nodeObj[key];
            return {
                name: `${node.alias}:  (${node.identity_pubkey})`,
                value: node.identity_pubkey
            }
        })
    })

    let destArray = [{
        name: `(choose random)`,
        value: nodeObj[activity.src].possible_dests[Math.floor(Math.random() * nodeObj[activity.src].possible_dests.length)].pub_key
    }, {
        name: '(input pubkey)',
        value: false
    }]

    activity.dest = await select({
        message: "Choose a destination? \n",
        choices: destArray.concat(nodeObj[activity.src].possible_dests.map(dest => {
            return {
                name: `${dest.alias}:  (${dest.pub_key})`,
                value: dest.pub_key
            }
        }))

    })

    if (!activity.dest) {
        activity.dest = await input({ message: 'Enter pubkey:' });
    }

    activity.action = await input({ message: 'What action?', default: "keysend" });

    activity.frequency = await getFrequency()
    activity.amount = await getAmountInSats()

    activities.push(activity);

    const anotherOne = await confirm({ message: 'Create another one?', default: false });
    console.log("\n------------------------");
    console.log(`Created: ${activity.uuid}\nTotal activities: ${activities.length}`);
    console.log("------------------------\n");
    if (anotherOne) {
        promptForActivities();
    } else {

        if (options.csv) activities = parse(activities, { header: true });
        config.activity = activities;
        console.log(config);
    }
}