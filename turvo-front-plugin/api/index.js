const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

// --- TURVO API DETAILS (Set as Environment Variables) ---
const TURVO_BASE_URL = process.env.TURVO_BASE_URL || 'https://my-sandbox-publicapi.turvo.com';
const TURVO_CLIENT_ID = process.env.TURVO_CLIENT_ID;
const TURVO_CLIENT_SECRET = process.env.TURVO_CLIENT_SECRET;
const TURVO_API_KEY = process.env.TURVO_API_KEY;
const TURVO_USERNAME = process.env.TURVO_USERNAME;
const TURVO_PASSWORD = process.env.TURVO_PASSWORD;

// --- Token Cache ---
let cachedToken = null;
let tokenExpiresAt = null;

/**
 * Gets a valid OAuth 2.0 token from Turvo.
 */
async function getAuthToken() {
  if (cachedToken && tokenExpiresAt && tokenExpiresAt > Date.now()) {
    return cachedToken;
  }

  console.log('Fetching new Turvo token...');
  const tokenUrl = `${TURVO_BASE_URL}/v1/oauth/token?client_id=${TURVO_CLIENT_ID}&client_secret=${TURVO_CLIENT_SECRET}`;
  const requestBody = {
    grant_type: 'password',
    username: TURVO_USERNAME,
    password: TURVO_PASSWORD,
    scope: 'read+trust+write',
    type: 'business',
  };

  try {
    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'x-api-key': TURVO_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      console.error('Turvo auth error response:', errorBody);
      throw new Error(`Turvo Auth API error: ${response.status}`);
    }

    const data = await response.json();
    cachedToken = data.access_token;
    // Set expiry 60 seconds early to be safe
    tokenExpiresAt = Date.now() + (data.expires_in - 60) * 1000; 
    console.log('Successfully fetched and cached new Turvo token.');
    return cachedToken;

  } catch (error) {
    console.error('Error fetching Turvo token:', error.message);
    cachedToken = null;
    tokenExpiresAt = null;
    throw error;
  }
}

/**
 * Parses the full Turvo shipment response into the flat structure our UI wants.
 */
function parseShipmentData(details) {
  if (!details) {
    throw new Error('Invalid response structure from Turvo. "details" object missing.');
  }

  const originStop = details.globalRoute?.[0];
  const destStop = details.globalRoute?.[details.globalRoute.length - 1];

  const formatAddress = (addr) => (addr ? `${addr.city || 'N/A'}, ${addr.state || 'N/A'}` : 'N/A');
  
  const getStopDetails = (stop) => {
    if (!stop) return { date: null, scheduling: 'N/A', window: 0 };
    return {
      date: stop.appointment?.date || null,
      scheduling: stop.schedulingType?.value || 'N/A',
      window: stop.appointment?.flex || 0,
    };
  };
  
  // Find BOL Number. From the API, key '1402' is 'BOL #'
  let bol = 'N/A';
  const externalIds = details.customerOrder?.[0]?.externalIds;
  if (externalIds) {
    const bolExt = externalIds.find(ext => ext.type?.key === '1402');
    if (bolExt) bol = bolExt.value;
  }

  return {
    internalId: details.id, 
    id: details.customId || details.id,
    turvoUrl: `https://app.turvo.com/shipments/${details.id}`,
    customer: details.customerOrder?.[0]?.customer?.name || 'N/A',
    bolNumber: bol,
    status: details.status?.description || 'N/A',
    statusKey: details.status?.code?.key || null, 
    type: details.transportation?.mode?.value || 'N/A',
    etd: details.startDate?.date || null,
    eta: details.endDate?.date || null,
    carrier: details.carrierOrder?.[0]?.carrier?.name || 'N/A',
    originLocation: formatAddress(originStop?.address),
    originPickup: getStopDetails(originStop),
    destLocation: formatAddress(destStop?.address),
    destDelivery: getStopDetails(destStop),
    currentLocation: {
      city: details.status?.location?.city || 'N/A',
      state: details.status?.location?.state || '',
      timestamp: details.status?.location?.currentDate || null,
    },
    predictedEta: details.status?.location?.nextEtaCalVal || null,
    statusHistory: details.statusHistory || [],
  };
}

/**
 * Fetches a shipment from Turvo using its main ID (e.g., 12102)
 */
const getShipmentByTurvoId = async (id) => {
  const endpoint = `${TURVO_BASE_URL}/v1/shipments/${id}`; 
  const token = await getAuthToken();
  console.log(`Fetching from Turvo Shipment API: ${endpoint}`);
  
  const response = await fetch(endpoint, {
    method: 'GET',
    headers: { 'Authorization': `Bearer ${token}` },
  });

  if (response.status === 404) return null; // Not found
  if (!response.ok) {
    throw new Error(`Turvo API error (ShipmentID): ${response.status}`);
  }
  const data = await response.json();
  return parseShipmentData(data.details);
};

/**
 * Fetches a shipment from Turvo using a BOL Number
 */
const getShipmentByBol = async (bol) => {
  const endpoint = `${TURVO_BASE_URL}/v1/shipments/list?bolNumber[eq]=${bol}`;
  const token = await getAuthToken();
  console.log(`Fetching from Turvo Search API: ${endpoint}`);

  const response = await fetch(endpoint, {
    method: 'GET',
    headers: { 'Authorization': `Bearer ${token}` },
  });

  if (!response.ok) {
    throw new Error(`Turvo API error (BOL Search): ${response.status}`);
  }

  const searchResults = await response.json();
  const shipmentSummary = searchResults.details?.shipments?.[0] || null;

  if (!shipmentSummary) return null; // Not found

  console.log(`Found summary for BOL ${bol}. Fetching full details for ID: ${shipmentSummary.id}`);
  return await getShipmentByTurvoId(shipmentSummary.id);
};


// --- ENDPOINT 1: GET SHIPMENT DETAILS ---
app.post('/api/shipment', async (req, res) => {
  let { id, type } = req.body;

  if (!id || !type) return res.status(400).json({ error: 'Missing ID or type' });
  
  if (type === 'shipmentID') id = id.replace(/\D/g, ''); 
  else if (type === 'bolNumber') id = id.trim();

  try {
    let shipmentData;
    if (type === 'shipmentID') {
      shipmentData = await getShipmentByTurvoId(id);
    } else if (type === 'bolNumber') {
      shipmentData = await getShipmentByBol(id);
    } else {
      return res.status(400).json({ error: 'Unknown search type' });
    }

    if (shipmentData) res.json(shipmentData);
    else res.status(404).json({ error: 'Shipment not found' });
    
  } catch (error) {
    console.error('Error in /api/shipment:', error.message);
    res.status(500).json({ error: 'Error connecting to Turvo' });
  }
});


// --- ENDPOINT 2: GET DOCUMENT LIST ---
app.get('/api/shipment/:id/documents', async (req, res) => {
  const { id } = req.params;
  const token = await getAuthToken();
  // Using the context query you helped me find
  const context = encodeURIComponent(JSON.stringify({ id: parseInt(id), type: "SHIPMENT" }));
  const endpoint = `${TURVO_BASE_URL}/v1/documents/list?context=${context}`;

  console.log(`Fetching documents from: ${endpoint}`);
  try {
    const response = await fetch(endpoint, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!response.ok) throw new Error('Turvo documents API error');
    const data = await response.json();
    res.json({ documents: data.details?.documents || [] });
  } catch (e) {
    console.error('Error fetching documents:', e.message);
    res.status(500).json({ error: 'Could not fetch documents' });
  }
});


// --- ENDPOINT 3: POST A NOTE ---
app.post('/api/shipment/:id/note', async (req, res) => {
  const { id } = req.params;
  const { note, statusKey } = req.body;
  
  if (!note || !statusKey) {
    return res.status(400).json({ error: 'Missing note or statusKey' });
  }
  
  const token = await getAuthToken();
  const endpoint = `${TURVO_BASE_URL}/v1/shipments/status/${id}`;
  
  const payload = {
    id: parseInt(id),
    status: {
      code: { key: statusKey }, // Update the *current* status
      notes: note // But add our new note
    }
  };

  console.log(`Posting note to: ${endpoint}`);
  try {
    const response = await fetch(endpoint, {
      method: 'PUT',
      headers: { 
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      console.error('Turvo note update error:', await response.text());
      throw new Error('Turvo API failed to post note.');
    }
    
    const data = await response.json();
    // Return the fresh status history
    res.json({ statusHistory: data.details?.statusHistory || [] });
    
  } catch (e) {
    console.error('Error posting note:', e.message);
    res.status(500).json({ error: 'Could not post note' });
  }
});


// --- ENDPOINT 4: ATTACH DOCUMENT FROM URL ---
app.post('/api/shipment/:id/documents/attach', async (req, res) => {
  const { id } = req.params;
  const { filename, fileUrl, fileType } = req.body;

  if (!filename || !fileUrl) {
    return res.status(400).json({ error: 'Missing filename or fileUrl' });
  }

  const token = await getAuthToken();
  // This is the endpoint for adding a doc from a URL
  const endpoint = `${TURVO_BASE_URL}/v2/documents/upload-via-urls`; 

  // We use key 3009 ("Other") as a default.
  let lookupKey = "3009";
  let lookupName = "Other";

  if (fileType.includes('pdf')) {
    lookupKey = "3005"; // Bill of lading (example)
    lookupName = "Bill of lading";
  } else if (fileType.includes('image')) {
    lookupKey = "3010"; // Proof of delivery (example)
    lookupName = "Proof of delivery";
  }
  
  // This payload is based on the Turvo API docs
  const payload = {
    context: {
      id: parseInt(id),
      type: "SHIPMENT"
    },
    attributes: {
      name: filename,
      urls: [fileUrl], // Turvo API expects an array of URLs
      lookupKey: lookupKey,
      lookupName: lookupName,
      create: true
    }
  };

  console.log(`Attaching file from URL: ${fileUrl}`);
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorBody = await response.json();
      console.error('Turvo attach error:', errorBody);
      // Check for a common error
      if (errorBody?.details?.errorMessage?.includes("Could not download file")) {
        throw new Error("Turvo server could not access the Front attachment URL. This is likely a security permissions issue.");
      }
      throw new Error(errorBody?.details?.errorMessage || 'Turvo API failed to attach file.');
    }

    const data = await response.json();
    res.json({ success: true, details: data.details });

  } catch (e) {
    console.error('Error attaching document:', e.message);
    res.status(500).json({ error: e.message });
  }
});


// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`TMS plugin backend listening on port ${PORT}`);
});