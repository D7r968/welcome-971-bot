'use strict';

const path = require('path');
const express = require('express');
const {
  Client,
  GatewayIntentBits,
  Events,
  PermissionFlagsBits,
  EmbedBuilder,
  AttachmentBuilder
} = require('discord.js');

const P = PermissionFlagsBits;
const GIF_PATH = path.join(__dirname, 'welcome.gif');
const WELCOME_GUILD = process.env.WELCOME_GUILD_NAME || '« Group |  EXPLOSIVE 971 »';
const WELCOME_LINE1 = process.env.WELCOME_TEXT || 'أهلاً بك';
const WELCOME_LINE2 = process.env.WELCOME_LINE2 || 'نورتنا';
const DM_TEXT = process.env.WELCOME_DM || 'هلا بك منور ي عسل';

/* ── خادم صغير عشان البوت يبقى شغال على Render (self ping) ── */
const app = express();
app.get('/', (_req, res) => res.json({ status: 'ok', bot: 'بوت ترحيب (971)' }));
app.get('/health', (_req, res) => res.json({ status: 'ok' }));
const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => console.log(`[web] health server on ${PORT}`));

const selfUrl = String(process.env.RENDER_EXTERNAL_URL || process.env.SELF_URL || '').replace(/\/+$/, '');
if (selfUrl) {
  setInterval(() => {
    fetch(selfUrl + '/health').catch(() => {});
  }, 5 * 60 * 1000).unref();
  console.log('[web] self ping → ' + selfUrl);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers]
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
    console.warn(`[!] WELCOME_CHANNEL_ID ما قدر يرسل فيه — بنختار قناة تانية`);
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
    .setAuthor({
      name: guild.name,
      iconURL: guild.iconURL({ dynamic: true, size: 128 }) || undefined
    })
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

client.once(Events.ClientReady, (c) => {
  console.log(`[✓] مسجّل دخول كـ ${c.user.tag}`);
  console.log(`[i] السيرفرات: ${c.guilds.cache.size}`);
  for (const g of c.guilds.cache.values()) {
    console.log(`   - ${g.name} (${g.id})`);
  }
  console.log(`[i] صلاحية GuildMembers: ${client.options.intents.has(GatewayIntentBits.GuildMembers) ? 'مفعّلة بالكود' : 'غير مفعّلة'}`);
});

client.on(Events.GuildMemberAdd, async (member) => {
  try {
    await welcomeMember(member);
  } catch (err) {
    console.error('[!] خطأ في حدث الدخول:', err);
  }
});

process.on('SIGTERM', () => {
  console.log('[i] SIGTERM — إغلاق آمن...');
  client.destroy();
  process.exit(0);
});

client.on(Events.Error, (err) => console.error('[!] خطأ في الاتصال:', err.message));

const token = String(process.env.DISCORD_TOKEN || '').trim();
if (!token) {
  console.error('[!] DISCORD_TOKEN غير مضبوط');
} else {
  // ما نخرج من العملية إذا فشل الدخول — خادم الصحة يبقى شغال، ونعيد المحاولة
  // تلقائياً لين يفعّل صاحب البوت صلاحية Server Members من بوابة المطوّرين
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
