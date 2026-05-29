/**
 * Unit tests for send-art-note-email.js
 *
 * Covers the contract the Art Hub note email depends on:
 *   • !toEmail            → skip with 'no-recipient', emailjs.send NOT called
 *   • detail_link suffix  → '?view=ae' when recipientIsRep, absent otherwise
 *                           (asserted via __test__.buildParams — no send)
 *   • resolves            → emailjs.send rejection returns {sent:false,error},
 *                           never throws (route fires this fire-and-forget)
 *
 * @emailjs/nodejs is mocked — tests never send mail.
 */
jest.mock('@emailjs/nodejs');
const emailjs = require('@emailjs/nodejs');

// EmailJS credentials must be present for the send path to be reached. Set
// BEFORE require so the module sees them (it reads them per-call, but set
// here for clarity / parity with the other senders).
process.env.EMAILJS_SERVICE_ID = 'service_test';
process.env.EMAILJS_PUBLIC_KEY = 'public_test';
process.env.EMAILJS_PRIVATE_KEY = 'private_test';

const mod = require('../../src/utils/send-art-note-email');
const { sendArtNoteEmail } = mod;
const { buildParams } = mod.__test__;

beforeEach(() => {
    emailjs.send.mockReset();
});

describe('sendArtNoteEmail — recipient guard', () => {
    test('blank toEmail → skipped:no-recipient, emailjs.send NOT called', async () => {
        const result = await sendArtNoteEmail({ idDesign: 40402, noteText: 'hi' });
        expect(result).toEqual({ sent: false, skipped: 'no-recipient' });
        expect(emailjs.send).not.toHaveBeenCalled();
    });

    test('null args → skipped:no-recipient without throwing', async () => {
        const result = await sendArtNoteEmail(null);
        expect(result.sent).toBe(false);
        expect(result.skipped).toBe('no-recipient');
        expect(emailjs.send).not.toHaveBeenCalled();
    });
});

describe('buildParams — detail_link view=ae suffix', () => {
    test("recipientIsRep true → detail_link ends with '?view=ae'", () => {
        const params = buildParams({
            toEmail: 'taneisha@nwcustomapparel.com',
            idDesign: 40402,
            recipientIsRep: true
        });
        expect(params.detail_link).toContain('/art-request/40402');
        expect(params.detail_link.endsWith('?view=ae')).toBe(true);
    });

    test("recipientIsRep false → detail_link has NO '?view=ae'", () => {
        const params = buildParams({
            toEmail: 'art@nwcustomapparel.com',
            idDesign: 40402,
            recipientIsRep: false
        });
        expect(params.detail_link).toContain('/art-request/40402');
        expect(params.detail_link).not.toContain('?view=ae');
    });

    test('recipientIsRep omitted (falsy) → no ?view=ae', () => {
        const params = buildParams({ toEmail: 'x@nwcustomapparel.com', idDesign: 7 });
        expect(params.detail_link).not.toContain('?view=ae');
    });

    test('maps the EmailJS template params used by template_art_note_added', () => {
        const params = buildParams({
            toEmail: 'taneisha@nwcustomapparel.com',
            toName: 'Taneisha',
            fromName: 'Steve (Art Dept)',
            idDesign: 40402,
            company: 'AutoShield',
            noteType: 'To Art',
            noteText: 'Tweak the logo.',
            recipientIsRep: true
        });
        expect(params).toMatchObject({
            to_email: 'taneisha@nwcustomapparel.com',
            to_name: 'Taneisha',
            design_id: '40402',
            company_name: 'AutoShield',
            note_type: 'To Art',
            header_emoji: '📝',
            note_text: 'Tweak the logo.',
            from_name: 'Steve (Art Dept)'
        });
    });

    test('default detailPath is /art-request/ (art callers unchanged)', () => {
        const params = buildParams({ toEmail: 'x@nwcustomapparel.com', idDesign: 40402 });
        expect(params.detail_link).toContain('/art-request/40402');
        expect(params.detail_link).not.toContain('/mockup/');
    });
});

describe('buildParams — mockup-note reuse (detailPath + linkId)', () => {
    test("detailPath '/mockup/' + linkId routes the link to the mockup page", () => {
        const params = buildParams({
            toEmail: 'ruth@nwcustomapparel.com',
            idDesign: '12345',     // human-facing Design_Number (display)
            linkId: 88,            // Digitizing_Mockups.ID (link target)
            detailPath: '/mockup/',
            recipientIsRep: false
        });
        // Link uses the mockup ID, not the design number.
        expect(params.detail_link).toContain('/mockup/88');
        expect(params.detail_link).not.toContain('/art-request/');
        expect(params.detail_link).not.toContain('/mockup/12345');
        // Displayed design_id still shows the human-facing Design_Number.
        expect(params.design_id).toBe('12345');
    });

    test('mockup rep recipient still gets ?view=ae on the /mockup/ link', () => {
        const params = buildParams({
            toEmail: 'taneisha@nwcustomapparel.com',
            idDesign: 'NIKE-01',
            linkId: 88,
            detailPath: '/mockup/',
            recipientIsRep: true
        });
        expect(params.detail_link).toContain('/mockup/88');
        expect(params.detail_link.endsWith('?view=ae')).toBe(true);
    });

    test('linkId falls back to idDesign when omitted', () => {
        const params = buildParams({
            toEmail: 'x@nwcustomapparel.com',
            idDesign: 777,
            detailPath: '/mockup/'
        });
        expect(params.detail_link).toContain('/mockup/777');
    });
});

describe('sendArtNoteEmail — send path', () => {
    test('happy path → emailjs.send called once, returns {sent:true}', async () => {
        emailjs.send.mockResolvedValue({ status: 200, text: 'OK' });

        const result = await sendArtNoteEmail({
            toEmail: 'taneisha@nwcustomapparel.com',
            toName: 'Taneisha',
            idDesign: 40402,
            company: 'AutoShield',
            noteType: 'To Art',
            noteText: 'hi',
            recipientIsRep: true
        });

        expect(result).toEqual({ sent: true });
        expect(emailjs.send).toHaveBeenCalledTimes(1);

        const [serviceId, templateId, templateParams, creds] = emailjs.send.mock.calls[0];
        expect(serviceId).toBe('service_test');
        expect(templateId).toBe('template_art_note_added');
        expect(templateParams.to_email).toBe('taneisha@nwcustomapparel.com');
        expect(templateParams.detail_link.endsWith('?view=ae')).toBe(true);
        expect(creds).toMatchObject({ publicKey: 'public_test', privateKey: 'private_test' });
    });

    test('emailjs.send rejection resolves to {sent:false,error} — never throws', async () => {
        // @emailjs/nodejs rejects with {status,text} objects lacking err.message.
        emailjs.send.mockRejectedValueOnce({ status: 422, text: 'Invalid recipient' });

        const result = await sendArtNoteEmail({
            toEmail: 'taneisha@nwcustomapparel.com',
            idDesign: 40402,
            noteText: 'hi'
        });

        expect(result.sent).toBe(false);
        expect(result.error).toMatch(/Invalid recipient/);
    });
});

describe('sendArtNoteEmail — missing EmailJS env', () => {
    test('missing private key → skipped:missing-env, send NOT called', async () => {
        jest.resetModules();
        const oldPrivate = process.env.EMAILJS_PRIVATE_KEY;
        delete process.env.EMAILJS_PRIVATE_KEY;

        jest.doMock('@emailjs/nodejs');
        const freshEmailjs = require('@emailjs/nodejs');
        const fresh = require('../../src/utils/send-art-note-email');

        const result = await fresh.sendArtNoteEmail({
            toEmail: 'taneisha@nwcustomapparel.com',
            idDesign: 40402,
            noteText: 'hi'
        });

        expect(result).toEqual({ sent: false, skipped: 'missing-env' });
        expect(freshEmailjs.send).not.toHaveBeenCalled();

        // Restore for the rest of the suite.
        process.env.EMAILJS_PRIVATE_KEY = oldPrivate;
        jest.resetModules();
    });
});
