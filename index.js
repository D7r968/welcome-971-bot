'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const { joinVoiceChannel, getVoiceConnection } = require('@discordjs/voice');
const {
  Client,
  GatewayIntentBits,
  Events,
  PermissionFlagsBits,
  EmbedBuilder,
  AttachmentBuilder,
  SlashCommandBuilder,
  REST,
  Routes
} = require('discord.js');

const P = PermissionFlagsBits;
const GIF_PATH = path.join(__dirname, 'welcome.gif');
const VOICE_FILE = path.join(__dirname, 'voice-state.json');
const WELCOME_GUILD = process.env.WELCOME_GUILD_NAME || '« Group |  EXPLOSIVE 971 »';
const WELCOME_LINE1 = process.env.WELCOME_TEXT || 'أهلاً بك';
const WELCOME_LINE2 = process.env.WELCOME_LINE2 || 'نورتنا';
const DM_TEXT = process.env.WELCOME_DM || 'هلا بك منور ي عسل';

/* ── حالة الجلوس في الروم الصوتي (محفوظة عشان ترجع بعد إعادة التشغيل) ── */
function loadVoiceState() {
  try {
    const x = JSON.parse(fs.readFileSync(VOICE_FILE, 'utf8'));
    return x && typeof x === 'object' ? x : {};
  } catch {
    return {};
  }
}
function saveVoiceState() {
  try {
    fs.writeFileSync(VOICE_FILE, JSON.stringify(voiceState, null, 2));
  } catch (err) {
    console.error('[!] فشل حفظ حالة الروم:', err.message);
  }
}
const voiceState = loadVoiceState();

/* ── خادم صغير عشان البوت يبقى شغال على Render (self ping) ── */
const app = express();
app.get('/', (_req, res) => res.json({ status: 'ok', bot: 'بوت ترحيب (971)' }));
app.get('/health', (_req, res) => res.json({ status: 'ok' }));
const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => console.log(`[web] health server on ${PORT}`));

const selfUrl = String(process.env.RENDER_EXTERNAL_URL || process.env.SELF_URL || '').replace(/\/+$/, '');
if (selfUrl) {
  setInterval(() => fetch(selfUrl + '/health').catch(() => {}), 5 * 60 * 1000).unref();
  console.log('[web] self ping → ' + selfUrl);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates
  ]
});

function canSend(ch, me) {
  if (!ch || !ch.isTextBased()) return false;
  const perms = ch.permissionsFor(me);
  return !!perms && perms.has([P.ViewChannel, P.SendMessages, P.EmbedLinks, P.AttachFiles]);
}

function pickWelcomeChannel(guild) {
  const me = guild.members.me;
  if (!me) return null;

  const forced = String(process.env.WELCOME_CHANNEL_ID || '').trim();
  if (forced) {
    const ch = guild.channels.cache.get(forced);
    if (canSend(ch, me)) return ch;
    console.warn('[!] WELCOME_CHANNEL_ID ما قدر يرسل فيه — بنختار قناة تانية');
  }

  if (canSend(guild.systemChannel, me)) return guild.systemChannel;

  const byName = guild.channels.cache.find(
    (ch) => canSend(ch, me) && /welcome|ترحيب|أهلا|اهلا|استقبال/i.test(ch.name)
  );
  if (byName) return byName;

  const general = guild.channels.cache.find(
    (ch) => canSend(ch, me) && /general|public|عام/i.test(ch.name)
  );
  if (general) return general;

  return guild.channels.cache.find((ch) => canSend(ch, me)) || null;
}

async function welcomeMember(member) {
  const guild = member.guild;
  const channel = pickWelcomeChannel(guild);
  if (!channel) {
    console.warn(`[!] ما لقيت قناة أرسل فيها الترحيب في ${guild.name}`);
    return;
  }

  const mention = `<@${member.id}>`;
  const text = `${WELCOME_LINE1} ${mention} في سيرفر ${WELCOME_GUILD}!\n${WELCOME_LINE2}`;

  const embed = new EmbedBuilder()
    .setColor('#FF8C00')
    .setAuthor({ name: guild.name, iconURL: guild.iconURL({ dynamic: true, size: 128 }) || undefined })
    .setThumbnail(member.user.displayAvatarURL({ dynamic: true, size: 256 }))
    .setDescription(`${WELCOME_LINE2} ${mention}`)
    .setImage('attachment://welcome.gif')
    .setFooter({ text: member.user.tag })
    .setTimestamp();

  try {
    await channel.send({
      content: text,
      allowedMentions: { parse: ['users'] },
      embeds: [embed],
      files: [new AttachmentBuilder(GIF_PATH, { name: 'welcome.gif' })]
    });
    console.log(`[✓] رحّبت بـ ${member.user.tag} في ${channel.name} / ${guild.name}`);
  } catch (err) {
    console.error('[!] فشل إرسال الترحيب:', err.message);
  }

  try {
    await member.send({
      content: DM_TEXT,
      files: [new AttachmentBuilder(GIF_PATH, { name: 'welcome.gif' })]
    });
    console.log(`[✓] أرسلت رسالة الخاص لـ ${member.user.tag}`);
  } catch (err) {
    console.warn(`[i] ما وصلت رسالة الخاص لـ ${member.user.tag}: ${err.message}`);
  }
}

/* ── أوامر الشرطة / ── */
function buildCommands() {
  return [
    new SlashCommandBuilder()
      .setName('join')
      .setDescription('أدخل البوت في الروم الصوتي وخليه جالس فيه')
      .addChannelOption((o) =>
        o.setName('channel').setDescription('القناة الصوتية (اتركها فاضية عشان يدخل رومك أنت)').setRequired(false)
      ),
    new SlashCommandBuilder()
      .setName('leave')
      .setDescription('أخرج البوت من الروم الصوتي'),
    new SlashCommandBuilder()
      .setName('status')
      .setDescription('اعرض حالة البوت في الروم الصوتي')
  ].map((c) => c.toJSON());
}

async function registerCommands() {
  const token = String(process.env.DISCORD_TOKEN || '').trim();
  if (!token || !client.user) return;
  try {
    const rest = new REST({ version: '10' }).setToken(token);
    const cmds = buildCommands();
    await rest.put(Routes.applicationCommands(client.user.id), { body: cmds });
    console.log('[✓] تم تسجيل أوامر /join و /leave و /status عالمياً');
    // تسجيل فوري في كل سيرفر عشان ما ننتظر ساعة لحد تظهر الأوامر عالمياً
    for (const guild of client.guilds.cache.values()) {
      try {
        await rest.put(Routes.applicationGuildCommands(client.user.id, guild.id), { body: cmds });
        console.log(`[✓] الأوامر جاهزة فوراً في ${guild.name}`);
      } catch (e) {
        console.warn(`[!] ما تسجّلت الأوامر في ${guild.name}: ${e.message}`);
      }
    }
  } catch (err) {
    console.error('[!] فشل تسجيل الأوامر:', err.message);
  }
}

function joinVoice(guild, channel, actorTag) {
  if (!channel || !channel.isVoiceBased()) return false;
  const me = guild.members.me;
  if (me) {
    const perms = channel.permissionsFor(me);
    if (perms && (!perms.has(P.Connect) || !perms.has(P.Speak))) return false;
  }

  const existing = getVoiceConnection(guild.id);
  if (existing && existing.joinConfig.channelId === channel.id) return true;
  if (existing) existing.destroy();

  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: true,
    selfMute: false
  });

  connection.on('error', (err) => console.error('[!] خطأ في الاتصال الصوتي:', err.message));

  voiceState[guild.id] = { channelId: channel.id, enabled: true };
  saveVoiceState();
  console.log(`[✓] البوت جالس في الروم ${channel.name} / ${guild.name} ${actorTag ? '— بدطلب من ' + actorTag : ''}`);
  return true;
}

function leaveVoice(guild) {
  const connection = getVoiceConnection(guild.id);
  if (connection) connection.destroy();
  voiceState[guild.id] = { channelId: null, enabled: false };
  saveVoiceState();
}

async function handleSlash(interaction) {
  const guild = interaction.guild;
  if (!guild) return interaction.reply({ content: '❌ هذا الأمر يشتغل داخل سيرفر بس.', flags: 64 });

  if (interaction.commandName === 'join') {
    const option = interaction.options.getChannel('channel');
    const channel = option || (interaction.member?.voice?.channel ?? null);
    if (!channel || !channel.isVoiceBased()) {
      return interaction.reply({ content: '❌ أدخل روم صوتي أول أو حدّد قناة بالأمر، ثم جرّب /join', flags: 64 });
    }
    const ok = joinVoice(guild, channel, interaction.user.tag);
    return interaction.reply({
      content: ok
        ? `✅ البوت صار جالس في <#${channel.id}> — بيبقى فيه طول ما البوت شغال، ويرجع لحاله لو انقطع.`
        : '❌ ما قدر أدخل الروم — تأكد إن البوت عنده صلاحية Connect / Speak وأن الروم ليس ممتلئاً.',
      flags: 64
    });
  }

  if (interaction.commandName === 'leave') {
    leaveVoice(guild);
    return interaction.reply({ content: '✅ طلعت من الروم الصوتي.', flags: 64 });
  }

  if (interaction.commandName === 'status') {
    const connection = getVoiceConnection(guild.id);
    const chId = connection?.joinConfig?.channelId || voiceState[guild.id]?.channelId;
    const ch = chId ? guild.channels.cache.get(chId) : null;
    return interaction.reply({
      content: ch
        ? `🔊 البوت جالس في <#${ch.id}> (${ch.name}) — محفوظ: ${voiceState[guild.id]?.enabled ? 'نعم' : 'لا'}`
        : '🔇 البوت ما جالس في أي روم حالياً.',
      flags: 64
    });
  }
}

client.once(Events.ClientReady, (c) => {
  console.log(`[✓] مسجّل دخول كـ ${c.user.tag}`);
  console.log(`[i] السيرفرات: ${c.guilds.cache.size}`);
  for (const g of c.guilds.cache.values()) console.log(`   - ${g.name} (${g.id})`);

  registerCommands();

  // رجّع البوت للروم المحفوظ بعد كل إعادة تشغيل
  for (const [gid, st] of Object.entries(voiceState)) {
    if (!st.enabled || !st.channelId) continue;
    const guild = c.guilds.cache.get(gid);
    const ch = guild?.channels.cache.get(st.channelId);
    if (guild && ch && ch.isVoiceBased()) joinVoice(guild, ch);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  try {
    await handleSlash(interaction);
  } catch (err) {
    console.error('[!] خطأ في الأمر:', err);
    const msg = '❌ صار خطأ في الأمر.';
    if (interaction.replied || interaction.deferred) await interaction.followUp({ content: msg, flags: 64 }).catch(() => {});
    else await interaction.reply({ content: msg, flags: 64 }).catch(() => {});
  }
});

client.on(Events.GuildMemberAdd, async (member) => {
  try {
    await welcomeMember(member);
  } catch (err) {
    console.error('[!] خطأ في حدث الدخول:', err);
  }
});

// إذا انقطع البوت عن الروم (مثلاً صيانة)، يرجع لحاله لين ما تطلعه أنت بأمر /leave
client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  if (newState.member?.id !== client.user?.id) return;
  if (oldState.channelId && !newState.channelId) {
    const st = voiceState[newState.guild.id];
    if (!st?.enabled || !st.channelId) return;
    setTimeout(() => {
      const guild = client.guilds.cache.get(newState.guild.id);
      const ch = guild?.channels.cache.get(st.channelId);
      if (guild && ch && ch.isVoiceBased()) joinVoice(guild, ch);
    }, 3000);
  }
});

client.on(Events.Error, (err) => console.error('[!] خطأ في الاتصال:', err.message));

process.on('SIGTERM', () => {
  console.log('[i] SIGTERM — إغلاق آمن...');
  client.destroy();
  process.exit(0);
});

const token = String(process.env.DISCORD_TOKEN || '').trim();
if (!token) {
  console.error('[!] DISCORD_TOKEN غير مضبوط');
} else {
  async function startLogin() {
    try {
      await client.login(token);
      console.log('[✓] تم تسجيل الدخول بنجاح');
    } catch (err) {
      console.error('[!] فشل تسجيل الدخول (' + err.message + ') — إعادة المحاولة خلال 30 ثانية...');
      setTimeout(startLogin, 30000);
    }
  }
  startLogin();
}
