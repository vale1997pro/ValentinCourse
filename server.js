// ===== SOSTITUISCI QUESTA FUNZIONE NEL TUO SERVER.JS =====

async function createGoogleMeetEvent(bookingData) {
    console.log('📅 createGoogleMeetEvent chiamata con:', {
        calendar: !!calendar,
        calendarId: process.env.GOOGLE_CALENDAR_ID,
        appointmentDate: bookingData.appointmentDate,
        appointmentTime: bookingData.appointmentTime
    });

    if (!calendar) {
        console.warn('⚠️ Google Calendar non configurato - saltando creazione evento');
        return null;
    }

    if (!process.env.GOOGLE_CALENDAR_ID) {
        console.warn('⚠️ GOOGLE_CALENDAR_ID non configurato - saltando creazione evento');
        return null;
    }

    // Calcola i tempi
    const appointmentDate = new Date(bookingData.appointmentDate);
    const [hours, minutes] = bookingData.appointmentTime.split(':');
    
    const startTime = new Date(appointmentDate);
    startTime.setHours(parseInt(hours), parseInt(minutes), 0, 0);
    
    const endTime = new Date(startTime);
    endTime.setMinutes(endTime.getMinutes() + 90);

    try {
        console.log('📅 Creazione evento Google Calendar con Meet link fisso:', {
            startTime: startTime.toISOString(),
            endTime: endTime.toISOString(),
            customerName: bookingData.customerName,
            customerEmail: bookingData.customerEmail
        });

        // Link Google Meet fisso (configurato su Render)
        const fixedMeetLink = process.env.GOOGLE_MEET_LINK || 'https://meet.google.com/tyv-rqts-nyr';

        const event = {
            summary: `VFX Consultation - ${bookingData.customerName}`,
            description: `
VFX Career Consultation with Valentin Procida

Cliente: ${bookingData.customerName}
Email: ${bookingData.customerEmail}
Telefono: ${bookingData.customerPhone}
${bookingData.company ? `Azienda: ${bookingData.company}` : ''}

Durata: 90 minuti
Pagamento: €${(bookingData.amount / 100).toFixed(2)}
ID Transazione: ${bookingData.paymentIntent}

🎥 GOOGLE MEET LINK: ${fixedMeetLink}

Argomenti da discutere:
- Analisi portfolio VFX
- Roadmap carriera personalizzata
- Strategie industria VFX
- CV e networking tips

IMPORTANTE: Il link Google Meet è incluso sopra
            `.trim(),
            start: {
                dateTime: startTime.toISOString(),
                timeZone: 'Europe/Rome',
            },
            end: {
                dateTime: endTime.toISOString(),
                timeZone: 'Europe/Rome',
            },
            location: fixedMeetLink, // Aggiunge il link anche nel campo location
            reminders: {
                useDefault: false,
                overrides: [
                    { method: 'email', minutes: 24 * 60 },
                    { method: 'popup', minutes: 10 }
                ]
            }
        };

        console.log('📅 Creazione evento con Meet link fisso:', fixedMeetLink);

        const createdEvent = await calendar.events.insert({
            calendarId: process.env.GOOGLE_CALENDAR_ID,
            resource: event,
            sendUpdates: 'none'
        });

        console.log('✅ Evento creato con Meet link fisso:', {
            eventId: createdEvent.data.id,
            meetLink: fixedMeetLink,
            eventLink: createdEvent.data.htmlLink
        });

        const meetingInfo = {
            eventId: createdEvent.data.id,
            meetLink: fixedMeetLink, // Usa il link fisso
            eventLink: createdEvent.data.htmlLink,
            startTime: startTime,
            endTime: endTime
        };

        console.log('🔗 Usato Google Meet Link fisso:', meetingInfo.meetLink);
        return meetingInfo;

    } catch (error) {
        console.error('❌ Errore creazione evento Google Calendar:', {
            message: error.message,
            code: error.code,
            errors: error.errors
        });
        return null;
    }
}
