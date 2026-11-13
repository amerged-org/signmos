/** Email-client-safe amerged Sign layout. Inputs are plain text, never HTML. */
export function renderBrandedEmail(input: {
	eyebrow: string;
	title: string;
	paragraphs: string[];
	lang?: "de" | "en";
	action: { label: string; url: string };
	note?: string;
	details?: Array<{ label: string; value: string }>;
}): string {
	const url = new URL(input.action.url);
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		throw new Error("Email action URL must use HTTP or HTTPS");
	}
	const paragraphs = input.paragraphs
		.map(
			(text) =>
				`<p style="margin:0 0 18px;font-family:Georgia,'Times New Roman',serif;font-size:17px;line-height:1.6;color:#484848;">${escapeText(text)}</p>`,
		)
		.join("");
	const details = input.details?.length
		? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-top:1px solid #d8d8d8;margin:24px 0;">${input.details
				.map(
					(item) =>
						`<tr><td style="padding:11px 0;border-bottom:1px solid #d8d8d8;font-family:Georgia,'Times New Roman',serif;font-size:15px;line-height:1.5;color:#171717;"><span style="font-family:'SFMono-Regular',Consolas,'Liberation Mono',monospace;font-size:10px;letter-spacing:.04em;color:#6b6b6b;">${escapeText(item.label)}</span><br>${escapeText(item.value)}</td></tr>`,
				)
				.join("")}</table>`
		: "";
	const note = input.note
		? `<p style="margin:24px 0 0;font-family:Georgia,'Times New Roman',serif;font-size:14px;line-height:1.6;color:#6b6b6b;">${escapeText(input.note)}</p>`
		: "";
	return `<!doctype html><html lang="${input.lang ?? "de"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeText(input.title)}</title></head><body style="margin:0;padding:0;background:#ffffff;color:#171717;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#ffffff;"><tr><td align="center" style="padding:24px 16px;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%;max-width:600px;"><tr><td style="padding:12px 0 22px;border-bottom:1px solid #171717;"><a href="https://amerged.com" style="text-decoration:none;"><img src="https://sign.amerged.com/amerged-logo-email.png" width="194" height="67" alt="amerged" style="display:block;border:0;width:194px;height:67px;"></a></td></tr><tr><td style="padding:25px 0 0;font-family:'SFMono-Regular',Consolas,'Liberation Mono',monospace;font-size:10px;line-height:1.5;letter-spacing:.08em;color:#6b6b6b;"><span style="color:#b12c2b;">■</span> &nbsp;amerged Sign / ${escapeText(input.eyebrow)}</td></tr><tr><td style="padding:20px 0 30px;"><h1 style="margin:0 0 24px;font-family:Georgia,'Times New Roman',serif;font-size:32px;font-weight:normal;line-height:1.15;letter-spacing:-.03em;color:#171717;">${escapeText(input.title)}<span style="color:#b12c2b;">.</span></h1>${paragraphs}${details}<table role="presentation" cellspacing="0" cellpadding="0"><tr><td bgcolor="#171717" style="background:#171717;"><a href="${escapeAttribute(input.action.url)}" style="display:inline-block;padding:14px 20px;color:#ffffff;font-family:Georgia,'Times New Roman',serif;font-size:16px;line-height:1.4;text-decoration:none;">${escapeText(input.action.label)}&nbsp; ↗</a></td></tr></table>${note}</td></tr><tr><td style="border-top:1px solid #d8d8d8;padding:18px 0 12px;font-family:'SFMono-Regular',Consolas,'Liberation Mono',monospace;font-size:10px;line-height:1.7;letter-spacing:.04em;color:#6b6b6b;">amerged Sign&nbsp; / &nbsp; <a href="https://amerged.com" style="color:#171717;text-decoration:none;">amerged.com</a></td></tr></table></td></tr></table></body></html>`;
}

function escapeAttribute(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

function escapeText(value: string): string {
	return escapeAttribute(value).replace(/\r\n?|\n/g, "<br>");
}
