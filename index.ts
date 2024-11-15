// import discord.js
import {
  Client,
  Events,
  GatewayIntentBits,
  PermissionsBitField,
} from "discord.js";
import Docker from "dockerode";
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();

const docker = new Docker();

docker.listContainers({ all: true }, async function (err, containers) {
  if (err) {
    console.error(err);
    return;
  }
  if (typeof containers === "undefined") {
    console.error("Containers not found");
    process.exit(1);
  }
  for (let containerInfo of containers) {
    console.log(containerInfo.Names);
    if (containerInfo.Names.includes("/dvm-bot")) {
      let c = docker.getContainer(containerInfo.Id);
      if (c == null) {
        console.error("Container not found");
        process.exit(1);
      }
      if (typeof c === "undefined") {
        console.error("Container not found");
        process.exit(1);
      }
      await c.remove({ force: true });
    }
  }

  console.log("Creating container");

  docker.createContainer(
    {
      Image: "ubuntu",
      Tty: true,
      Cmd: ["/bin/bash"],
      name: "dvm-bot",
      OpenStdin: true,
    },
    function (err, container) {
      if (err) {
        console.error(err);
        process.exit(1);
      }
      if (typeof container === "undefined") {
        process.exit(1);
      }
      console.log("Container created");
      container.start({}, function () {
        console.log("Container started");
      });
      container.attach(
        { stream: true, stdin: true, stdout: true, stderr: true },
        function (err?: any, stream?: NodeJS.ReadWriteStream) {
          if (err) {
            console.error(err);
            process.exit(1);
          }
          if (typeof stream === "undefined") {
            console.error("Stream not found");
            process.exit(1);
          }
          console.log("Attached to container");
          stream.setEncoding("utf8");

          // Buffer for each channel to store pending data
          const channelBuffers = new Map<
            string,
            { buffer: string; timer: NodeJS.Timer | null }
          >();

          // Send buffer content if it exceeds 2000 characters or after a set interval (e.g., 500 ms)
          async function flushChannelBuffer(chan: any, channel: any) {
            if (channelBuffers.has(chan.channelId)) {
              const { buffer } = channelBuffers.get(chan.channelId)!;

              if (buffer.length === 0) return;

              // Send or edit the message based on message ID
              if (chan.messageId !== "") {
                let ch = await channel.messages.fetch(chan.messageId);
                if (ch.content === buffer) return;
                await ch.edit("```" + buffer + "```");
              } else {
                let msg = await channel.send("```" + buffer + "```");
                chan.messageId = msg.id;
              }
            }
            return chan;
          }

          stream.on("data", async function (chunk: any) {
            console.log(chunk);
            // Clean up the chunk
            chunk = chunk.replace(
              /(\x1b\[[0-9;?]*[A-Za-z])|(\x1b\][^\x07]*\x07)|(\x1b[>=])/g,
              ""
            );

            for (let chan of channelIds) {
              let channel = client.channels.cache.get(chan.channelId);
              if (
                !channel ||
                typeof channel === "undefined" ||
                !channel.isSendable()
              ) {
                console.error("Channel not found or not sendable");
                continue;
              }

              // Initialize buffer and timer for the channel if not present
              if (!channelBuffers.has(chan.channelId)) {
                channelBuffers.set(chan.channelId, { buffer: "", timer: null });
              }

              const { buffer, timer } = channelBuffers.get(chan.channelId)!;

              // Append chunk to buffer if it doesn't exceed 2000 characters
              if (buffer.length + chunk.length + 6 < 2000) {
                channelBuffers.set(chan.channelId, {
                  buffer: buffer + chunk,
                  timer,
                });
              } else {
                // If buffer is too large, flush immediately
                chan = await flushChannelBuffer(chan, channel);
                chan.messageId = "";

                // Set new chunk in buffer
                channelBuffers.set(chan.channelId, {
                  buffer: chunk,
                  timer: null,
                });
              }

              // If there's no active timer, set one to flush after a delay
              if (!timer) {
                const newTimer: NodeJS.Timer = setTimeout(async () => {
                  chan = await flushChannelBuffer(chan, channel);
                }, 500); // Adjust delay as needed for optimal batching

                channelBuffers.set(chan.channelId, {
                  buffer: buffer + chunk,
                  timer: newTimer,
                });
              }
            }
          });

          client.on("sendToContainer", (message) => {
            stream.write(message);
          });
        }
      );
    }
  );
});

// Make an array of channel IDs but the data types is an object with the id, last message id, and last content
let channelIds: {
  channelId: string;
  messageId: string;
  lastContent: string;
}[] = [];

try {
  const data = fs.readFileSync("config.json", "utf8");
  const config = JSON.parse(data);
  channelIds = config.channelIds;
} catch (err) {
  console.error(err);
}

// create a new Client instance
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessages,
  ],
});

// listen for the client to be ready
client.once(Events.ClientReady, (c) => {
  console.log(`Ready! Logged in as ${c.user.tag}`);
});

client.on(Events.MessageCreate, (message) => {
  if (message.author.bot) return;
  if (message.content === "!setup") {
    if (
      !message.member?.permissions.has(PermissionsBitField.Flags.Administrator)
    ) {
      message.channel.send("You do not have permission to set up the channel");
      return;
    }
    if (channelIds.map((c) => c.channelId).includes(message.channel.id)) {
      message.channel.send("Channel already set up");
    } else {
      channelIds.push({
        messageId: "",
        lastContent: "",
        channelId: message.channel.id,
      });
      fs.writeFileSync("config.json", JSON.stringify({ channelIds }));
      message.channel.send("Channel set up");
    }
  } else if (message.content === "!remove") {
    if (
      !message.member?.permissions.has(PermissionsBitField.Flags.Administrator)
    ) {
      message.channel.send("You do not have permission to remove the channel");
      return;
    }
    if (channelIds.map((c) => c.channelId).includes(message.channel.id)) {
      channelIds = channelIds.filter((c) => c.channelId !== message.channel.id);
      fs.writeFileSync("config.json", JSON.stringify({ channelIds }));
      message.channel.send("Channel removed");
    } else {
      message.channel.send("Channel not set up");
    }
  } else if (channelIds.map((c) => c.channelId).includes(message.channel.id)) {
    client.emit("sendToContainer", message.content + "\n");
    message.delete();
  }
});

process.on("exit", () => {
  fs.writeFileSync("config.json", JSON.stringify({ channelIds }));
});

// login with the token from .env.local
client.login(process.env.DISCORD_TOKEN);
