// server.js

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const axios = require('axios');
const hubspot = require('@hubspot/api-client');

const app = express();
const PORT = process.env.PORT || 3001;

// ---- HubSpot config ----
const HUBSPOT_ACCESS_TOKEN = process.env.HUBSPOT_ACCESS_TOKEN;
const HUBSPOT_API_BASE = 'https://api.hubapi.com';

if (!HUBSPOT_ACCESS_TOKEN) {
  console.error('❌ HUBSPOT_ACCESS_TOKEN is not set in .env');
  process.exit(1);
}

const hubspotClient = new hubspot.Client({
  accessToken: HUBSPOT_ACCESS_TOKEN,
});

// ---- Middleware ----
app.use(cors());
app.use(express.json());

// Serve static files from /public
app.use(express.static(path.join(__dirname, 'public')));

// ---- Health check ----
app.get('/health', (req, res) => {
  res.json({
    status: 'Server is running',
    timestamp: new Date().toISOString(),
  });
});

// ---- Helper: HubSpot axios instance ----
const hubspotAxios = axios.create({
  baseURL: HUBSPOT_API_BASE,
  headers: {
    Authorization: `Bearer ${HUBSPOT_ACCESS_TOKEN}`,
    'Content-Type': 'application/json',
  },
});

// ------------------------------------------------------------
//  CONTACTS
// ------------------------------------------------------------

// GET /api/contacts
// Fetch up to 50 contacts from HubSpot
app.get('/api/contacts', async (req, res) => {
  try {
    const response = await hubspotAxios.get('/crm/v3/objects/contacts', {
      params: {
        limit: 50,
        properties: [
          'firstname',
          'lastname',
          'email',
          'phone',
          'address',
          'jobtitle',
          'company',
        ].join(','),
      },
    });

    res.json({
      results: response.data.results || [],
    });
  } catch (error) {
    console.error(
      'Error fetching contacts:',
      error.response?.data || error.message
    );
    res.status(500).json({
      error: 'Failed to fetch contacts',
      details: error.response?.data || error.message,
    });
  }
});

// POST /api/contacts
// Create a new contact in HubSpot.
// If the email already exists, return the existing contact ID instead of failing.
app.post('/api/contacts', async (req, res) => {
  try {
    const contactData = {
      properties: req.body.properties,
    };

    const response = await hubspotAxios.post(
      '/crm/v3/objects/contacts',
      contactData
    );

    // New contact created successfully
    return res.json(response.data);
  } catch (error) {
    const hubspotError = error.response?.data;
    const statusCode = error.response?.status;
    const category = hubspotError?.category;
    const message = hubspotError?.message || '';

    console.error('Error creating contact:', hubspotError || error.message);

    // Handle "Contact already exists" conflict gracefully
    if (statusCode === 409 || category === 'CONFLICT') {
      // Attempt to extract the existing ID from the error message
      // Example: "Contact already exists. Existing ID: 179556362935"
      let existingId = null;
      const match = message.match(/Existing ID:\s*(\d+)/);
      if (match && match[1]) {
        existingId = match[1];
      }

      if (existingId) {
        // Return as if we "got" a contact, but mark it as existing
        return res.json({
          id: existingId,
          properties: req.body.properties || {},
          existing: true,
        });
      }

      // Fallback if we can't parse the ID
      return res.status(409).json({
        error: 'Contact already exists',
        details: hubspotError || message,
      });
    }

    // All other errors
    return res.status(500).json({
      error: 'Failed to create contact',
      details: hubspotError || error.message,
    });
  }
});

// GET /api/contacts/by-email?email=foo@bar.com
// Look up a contact by exact email using HubSpot CRM Search API
app.get('/api/contacts/by-email', async (req, res) => {
  const email = req.query.email;

  if (!email) {
    return res.status(400).json({
      error: 'Missing email parameter',
      details: 'Please provide ?email=example@domain.com',
    });
  }

  try {
    const searchRequest = {
      filterGroups: [
        {
          filters: [
            {
              propertyName: 'email',
              operator: 'EQ',
              value: email,
            },
          ],
        },
      ],
      properties: ['firstname', 'lastname', 'email'],
      limit: 1,
    };

    const response = await hubspotClient.crm.contacts.searchApi.doSearch(
      searchRequest
    );
    const results = response.results || [];

    if (results.length === 0) {
      // No contact found with that email
      return res.json({ found: false });
    }

    const contact = results[0];
    return res.json({
      found: true,
      contact: {
        id: contact.id,
        properties: contact.properties,
      },
    });
  } catch (error) {
    console.error('Error searching contact by email:', error);
    res.status(500).json({
      error: 'Failed to search contact by email',
      details: error.message || String(error),
    });
  }
});

// ------------------------------------------------------------
//  DEALS
// ------------------------------------------------------------

// GET /api/deals
// Fetch up to 50 deals from HubSpot
app.get('/api/deals', async (req, res) => {
  try {
    const response = await hubspotAxios.get('/crm/v3/objects/deals', {
      params: {
        limit: 50,
        properties: [
          'dealname',
          'amount',
          'dealstage',
          'closedate',
          'pipeline',
        ].join(','),
      },
    });

    res.json({
      results: response.data.results || [],
    });
  } catch (error) {
    console.error(
      'Error fetching deals:',
      error.response?.data || error.message
    );
    res.status(500).json({
      error: 'Failed to fetch deals',
      details: error.response?.data || error.message,
    });
  }
});

// POST /api/deals
// Create a new deal and associate it with a contact
app.post('/api/deals', async (req, res) => {
  const { dealProperties, contactId } = req.body;

  if (!dealProperties || !contactId) {
    return res.status(400).json({
      error: 'Missing dealProperties or contactId',
      details:
        'Request body must include { dealProperties: {...}, contactId: "123" }',
    });
  }

  try {
    // 1) Create the deal
    const dealResponse = await hubspotAxios.post('/crm/v3/objects/deals', {
      properties: dealProperties,
    });

    const deal = dealResponse.data;
    const dealId = deal.id;

    // 2) Associate the deal with the contact
    // Using v4 associations API is recommended, but we can also use v3 with associationTypeId=3
    // Here we use the v3 association endpoint for simplicity.
    await hubspotAxios.put(
      `/crm/v3/objects/deals/${dealId}/associations/contacts/${contactId}/3`
    );

    res.json(deal);
  } catch (error) {
    console.error(
      'Error creating deal:',
      error.response?.data || error.message
    );
    res.status(500).json({
      error: 'Failed to create deal',
      details: error.response?.data || error.message,
    });
  }
});

// GET /api/contacts/:contactId/deals
// Get all deals associated with a specific contact
app.get('/api/contacts/:contactId/deals', async (req, res) => {
  const contactId = req.params.contactId;

  try {
    // 1) Get associated deals for this contact
    const assocResponse = await hubspotAxios.get(
      `/crm/v4/objects/contacts/${contactId}/associations/deals`,
      {
        params: {
          limit: 100,
        },
      }
    );

    const associations = assocResponse.data.results || [];
    const dealIds = associations
      .map((assoc) => assoc.toObjectId)
      .filter(Boolean);

    if (dealIds.length === 0) {
      return res.json({ results: [] });
    }

    // 2) Batch read deals to get their properties
    const batchResponse = await hubspotAxios.post(
      '/crm/v3/objects/deals/batch/read',
      {
        properties: ['dealname', 'amount', 'dealstage', 'closedate', 'pipeline'],
        inputs: dealIds.map((id) => ({ id })),
      }
    );

    const deals = batchResponse.data.results || [];

    res.json({
      results: deals,
    });
  } catch (error) {
    console.error(
      'Error fetching deals for contact:',
      error.response?.data || error.message
    );
    res.status(500).json({
      error: 'Failed to fetch deals for contact',
      details: error.response?.data || error.message,
    });
  }
});

// ------------------------------------------------------------
//  START SERVER + GRACEFUL SHUTDOWN
// ------------------------------------------------------------

const server = app.listen(PORT, () => {
  console.log('✅ Server running successfully!');
  console.log(`🌐 API available at: http://localhost:${PORT}`);
  console.log(`📋 Health check: http://localhost:${PORT}/health`);
  console.log(`📁 Static files served from: /public`);
});

// Graceful shutdown on Ctrl+C
process.on('SIGINT', () => {
  console.log('\nShutting down server...');
  server.close(() => {
    console.log('Server closed. Goodbye.');
    process.exit(0);
  });
});
