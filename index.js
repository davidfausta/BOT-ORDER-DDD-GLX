const qrcodeTerminal = require('qrcode-terminal');
const qrcodeImage = require('qrcode');
const { Client, LocalAuth } = require('whatsapp-web.js');
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// Set up WA Client
// Using LocalAuth saves the session so you don't have to scan QR every time it restarts
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
});

let isClientReady = false;
let currentQR = '';

client.on('qr', (qr) => {
    console.log('--- SCAN QR CODE INI DENGAN WHATSAPP ANDA ---');
    qrcodeTerminal.generate(qr, { small: true });
    currentQR = qr; // Simpan QR string untuk ditampilkan di web
});

client.on('ready', () => {
    console.log('✅ WhatsApp Bot is Ready!');
    isClientReady = true;
    currentQR = ''; // Hapus QR dari memory karena sudah login
});

client.on('authenticated', () => {
    console.log('✅ Authenticated successfully!');
});

client.on('auth_failure', msg => {
    console.error('❌ Authentication failure', msg);
});

client.initialize();

/**
 * Utility untuk memformat nomor HP lokal (08xxx) menjadi format target WA (628xxx@c.us)
 */
const formatPhoneNumber = (number) => {
    let formatted = number.replace(/\D/g, ''); // bersihkan karakter non-angka
    if (formatted.startsWith('0')) {
        formatted = '62' + formatted.substring(1);
    }
    if (!formatted.endsWith('@c.us')) {
        formatted += '@c.us';
    }
    return formatted;
};

// ==========================================
// API ENDPOINTS (DIPANGGIL DARI REACT APP)
// ==========================================

// Endpoint: Tampilkan QR Code di Browser
app.get('/qr', async (req, res) => {
    if (isClientReady) {
        return res.send('<h3>✅ Bot WhatsApp sudah sukses login. Tidak perlu scan QR lagi.</h3>');
    }

    if (!currentQR) {
        return res.send('<h3>⏳ Sedang memuat QR Code. Refresh halaman ini 5 detik lagi...</h3>');
    }

    try {
        const qrImage = await qrcodeImage.toDataURL(currentQR);
        res.send(`
            <html>
                <body style="display:flex; flex-direction:column; align-items:center; justify-content:center; height:100vh; background:#111; color:white; font-family:sans-serif;">
                    <h2>Scan QR Code Bawah Ini Dengan WhatsApp Anda</h2>
                    <div style="background:white; padding:20px; border-radius:10px;">
                        <img src="${qrImage}" alt="WhatsApp QR Code" />
                    </div>
                    <p>Setelah di-scan, tutup halaman ini.</p>
                </body>
            </html>
        `);
    } catch (err) {
        res.status(500).send('Gagal membuat gambar QR Code');
    }
});

// Endpoint 1: Notifikasi Order Baru ke Grup (dan info ke Pemohon)
app.post('/api/send-order', async (req, res) => {
    if (!isClientReady) {
        return res.status(503).json({ success: false, message: 'Bot WhatsApp belum siap. Silakan scan QR dulu.' });
    }

    const { order, targetGroupId } = req.body;

    if (!order) {
        return res.status(400).json({ success: false, message: 'Data order tidak lengkap.' });
    }

    try {
        const { id, name, division, contact, deadline, title, type, subdiv, brief, ref } = order;

        // Pesan untuk GRUP TUGAS
        const groupMsg = `🔔 *ORDER KONTEN BARU MASUK!* 🔔
Order ID: *#${id.slice(-4)}*
Subdivisi Tujuan: *${subdiv}* ${type ? `(${type})` : ''}

👤 *Pemohon*: ${name} (${division})
📱 *Kontak*: ${contact}
📅 *Deadline*: ${deadline}
📝 *Judul Konten*: ${title}

🔗 *Link Brief/Doc*:
${brief}

${ref ? `🔗 *Referensi/Asset Tambahan*: \n${ref}\n` : ''}
Segera diproses yuk, tim divisi DDD! 💪`;

        // Pesan Japri (Langsung) ke PEMOHON
        const customerMsg = `Halo *${name}*! 👋
Terima kasih telah melakukan order ke Divisi DDD (Sistem Order ddd-gelex).

Orderan Anda dengan detail:
📝 Judul: *${title}*
🆔 Ticket ID: *#${id.slice(-4)}*
📅 Deadline: *${deadline}*

Telah berhasil kami terima dan sedang *Menunggu* untuk diproses.
Mohon ditunggu info *Progress* selanjutnya ya! Jika ada pertanyaan, balas pesan ini atau hubungi Admin.

_Pesan ini dikirim otomatis oleh sistem_`;

        // 1. Kirim ke Grup Tujuan (Jika ada Target ID-nya)
        if (targetGroupId) {
            await client.sendMessage(targetGroupId, groupMsg);
        }

        // 2. Kirim Japri ke Pemohon (Jika ada nomor kontaknya)
        if (contact) {
            const formattedContact = formatPhoneNumber(contact);
            await client.sendMessage(formattedContact, customerMsg);
        }

        res.json({ success: true, message: 'Notifikasi Order (Grup & Customer) berhasil dikirim!' });
    } catch (error) {
        console.error('Failed to send WA:', error);
        res.status(500).json({ success: false, message: error.toString() });
    }
});

// Endpoint 2: Notifikasi Perubahan Status ke Customer
app.post('/api/send-status-update', async (req, res) => {
    if (!isClientReady) {
        return res.status(503).json({ success: false, message: 'Bot WhatsApp belum siap.' });
    }

    const { order, oldStatus, newStatus } = req.body;

    if (!order || !order.contact) {
        return res.status(400).json({ success: false, message: 'Data order atau nomor kontak tidak ada.' });
    }

    // Mapping icon untuk status
    const statusMap = {
        'Menunggu': '⏳ Menunggu',
        'Progress': '🔄 Sedang Diproses',
        'Review': '📝 Menunggu Review',
        'Done': '✅ Selesai',
        'Cancelled': '❌ Dibatalkan'
    };

    const displayStatus = statusMap[newStatus] || newStatus;

    let updateMsg = `Halo *${order.name}*! 👋
Order Divisi DDD Anda (Ticket: *#${order.id.slice(-4)}*) mengalami perubahan status:

Status sebelumnya: ${statusMap[oldStatus] || oldStatus}
🌟 *Status Terbaru: ${displayStatus}*

📝 Judul: *${order.title}*
`;

    // Jika Done, tambahkan info hasil/tindak lanjut 
    if (newStatus === 'Done') {
        updateMsg += `\n🎉 Order Anda telah Selesai! Terima kasih atas kerjasamanya.`;
        if (order.resultLink) {
            updateMsg += `\n🔗 Link Hasil: ${order.resultLink}`;
        }
    } else if (newStatus === 'Review') {
        updateMsg += `\nSilakan cek hasil sementara dan lakukan review (maks. 3x revisi major).`;
        if (order.resultLink) {
            updateMsg += `\n🔗 Link Dokumen/Hasil: ${order.resultLink}`;
        }
    } else if (newStatus === 'Progress') {
        updateMsg += `\nTim kami sedang mengerjakan order Anda dari sekarang. Jika ada tambahan info, segera kabari Admin ya!`;
    }

    updateMsg += `\n\n_Pesan otomatis dikirim oleh ddd-gelex system_`;

    try {
        const formattedContact = formatPhoneNumber(order.contact);
        await client.sendMessage(formattedContact, updateMsg);
        res.json({ success: true, message: 'Update status berhasil dikirim ke customer!' });
    } catch (error) {
        console.error('Failed to send status update WA:', error);
        res.status(500).json({ success: false, message: error.toString() });
    }
});

// Start Server
const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`📡 WA Bot Server API running on port ${PORT}`);
});
