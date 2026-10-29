/*
  =============================================================================
  ROOM TRACK BOT - Complete ESP32 Firmware with INMP441 Voice Recognition
  =============================================================================
  Features:
  1. TOUCHLESS PROXIMITY DETECTION:
     - HC-SR04 Ultrasonic sensor detects visitor approaching (< 40cm) for 500ms.
     - Automatically triggers voice prompt: "Please Speak Name".
  2. INMP441 DIGITAL I2S VOICE RECORDING:
     - 24-bit/32-bit I2S audio sampled at 16,000 Hz, converted to 16-bit mono WAV.
     - Records 3 seconds of crystal-clear digital speech.
  3. AI SPEECH-TO-TEXT & SEARCH (Groq Whisper + PostgreSQL):
     - Sends WAV audio to backend Express server: POST /api/device/voice-search.
     - Recognizes single name (e.g. "Santhosh") or combined name + father/city 
       (e.g. "Santhosh Ramasamy", "Santhosh son of Ramasamy").
  4. BILINGUAL VOICE & VISUAL GUIDANCE:
     - LCD displays Patient Name, Floor and Room.
     - DFPlayer Mini announces in English & Tamil.
  5. WEBSITE VISITOR SYNC:
     - Polls /api/device/next-patient for dispatches from the staff/visitor website.

  Pin Setup:
  - LCD I2C:       SDA -> GPIO 21, SCL -> GPIO 22 (Address: 0x27)
  - Ultrasonic:    TRIG -> GPIO 5, ECHO -> GPIO 18 (via 1k/2k voltage divider)
  - DFPlayer Mini: RX -> GPIO 16, TX -> GPIO 17 (via 1k resistor)
  - INMP441 Mic:   SCK (BCLK) -> GPIO 14
                   WS (LRCK)  -> GPIO 15
                   SD (DIN)   -> GPIO 32
                   L/R        -> GND (Left channel mono)
                   VDD        -> 3.3V ONLY
                   GND        -> GND
  =============================================================================
*/

#include <WiFi.h>
#include <WiFiUdp.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <Wire.h>
#include <LiquidCrystal_I2C.h>
#include <DFRobotDFPlayerMini.h>
#include <HardwareSerial.h>
#include <driver/i2s.h>

WiFiUDP udpDiscovery;

// ======================== WI-FI CONFIGURATION ========================
const char* WIFI_SSID     = "Santhosh 15";    // Hotspot SSID
const char* WIFI_PASSWORD = "0987654321";   // Hotspot Password

// Dynamic Backend API (Auto-Discovered over UDP on Port 4001, fallback to LAN IP)
String API_BASE          = "http://10.98.247.79:4000/api";
const char* API_KEY      = "esp32-room-track-bot-secret-key-32chars";

// ======================== PIN ASSIGNMENTS ========================
static const int TRIG_PIN      = 5;
static const int ECHO_PIN      = 18;
static const int DF_RX_PIN     = 16; // ESP32 RX (connect to DFPlayer TX)
static const int DF_TX_PIN     = 17; // ESP32 TX (connect to DFPlayer RX via 1k resistor)
static const int GREEN_LED_PIN = 4;  // Green Indicator LED on GPIO 4 (Safe non-strapping pin)
static const int BUTTON_PIN    = 23; // Voice Input Push Button on GPIO 23 (INPUT_PULLUP to GND)

// INMP441 I2S Pins
#define I2S_PORT        I2S_NUM_0
#define I2S_SCK_PIN     14  // BCLK / Serial Clock
#define I2S_WS_PIN      15  // LRCK / Word Select
#define I2S_SD_PIN      32  // DIN / Serial Data

// Audio Recording Specs
#define SAMPLE_RATE     16000
#define RECORD_SECONDS  3
#define NUM_SAMPLES     (SAMPLE_RATE * RECORD_SECONDS) // 48,000 samples
#define WAV_DATA_SIZE   (NUM_SAMPLES * sizeof(int16_t)) // 96,000 bytes
#define WAV_HEADER_SIZE 44
#define TOTAL_WAV_SIZE  (WAV_HEADER_SIZE + WAV_DATA_SIZE)

static const uint8_t LCD_ADDR = 0x27;
static const int DF_VOLUME    = 22; // Volume (0 to 30)

// Workflow Timing Constants
static const unsigned long POLL_INTERVAL_MS      = 2000;  // Poll website every 2s
static const unsigned long HEARTBEAT_INTERVAL_MS = 5000;  // Heartbeat every 5s
static const unsigned long COOLDOWN_DURATION_MS  = 6000;  // 6s cooldown after response
static const unsigned long HTTP_TIMEOUT_MS       = 10000; // 10s timeout for voice STT

LiquidCrystal_I2C lcd(LCD_ADDR, 16, 2);
HardwareSerial dfSerial(2);
DFRobotDFPlayerMini player;

bool playerReady = false;
bool i2sReady = false;
unsigned long lastPoll = 0;
unsigned long lastHeartbeat = 0;
unsigned long cooldownEndTime = 0;

// State Machine
enum BotState {
  STATE_STANDBY,
  STATE_CONFIRMING_PERSON,
  STATE_WAITING_FOR_BUTTON,
  STATE_RECORDING,
  STATE_PROCESSING
};

BotState currentState = STATE_STANDBY;
unsigned long personDetectionStart = 0;
unsigned long buttonWaitStart = 0;

// ======================== I2S INITIALIZATION ========================
void initI2S() {
  i2s_config_t i2s_config = {
    .mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_RX),
    .sample_rate = SAMPLE_RATE,
    .bits_per_sample = I2S_BITS_PER_SAMPLE_32BIT, // INMP441 outputs 24-bit in 32-bit slot
    .channel_format = I2S_CHANNEL_FMT_RIGHT_LEFT, // Read both channels to auto-detect L/R pin
    .communication_format = i2s_comm_format_t(I2S_COMM_FORMAT_STAND_I2S),
    .intr_alloc_flags = ESP_INTR_FLAG_LEVEL1,
    .dma_buf_count = 4,
    .dma_buf_len = 512,
    .use_apll = false,
    .tx_desc_auto_clear = false,
    .fixed_mclk = 0
  };

  i2s_pin_config_t pin_config = {
    .bck_io_num = I2S_SCK_PIN,
    .ws_io_num = I2S_WS_PIN,
    .data_out_num = I2S_PIN_NO_CHANGE,
    .data_in_num = I2S_SD_PIN
  };

  esp_err_t err = i2s_driver_install(I2S_PORT, &i2s_config, 0, NULL);
  if (err != ESP_OK) {
    Serial.printf("ERROR: Failed to install I2S driver: %d\n", err);
    return;
  }

  err = i2s_set_pin(I2S_PORT, &pin_config);
  if (err != ESP_OK) {
    Serial.printf("ERROR: Failed to set I2S pins: %d\n", err);
    return;
  }

  i2sReady = true;
  Serial.println(">>> INMP441 I2S Microphone Ready!");
}

// Parse URL into host, port, and path
void parseUrl(String url, String &host, int &port, String &path) {
  if (url.startsWith("http://")) url = url.substring(7);
  else if (url.startsWith("https://")) url = url.substring(8);

  int slashIdx = url.indexOf('/');
  String hostPort = (slashIdx >= 0) ? url.substring(0, slashIdx) : url;
  path = (slashIdx >= 0) ? url.substring(slashIdx) : "/";

  int colonIdx = hostPort.indexOf(':');
  if (colonIdx >= 0) {
    host = hostPort.substring(0, colonIdx);
    port = hostPort.substring(colonIdx + 1).toInt();
  } else {
    host = hostPort;
    port = 80;
  }
}

// Generate Standard 44-byte WAV Header
void createWavHeader(byte* header, int totalDataLen) {
  int totalFileLen = totalDataLen + 36;
  int byteRate = SAMPLE_RATE * 1 * sizeof(int16_t); // 16000 * 1 channel * 2 bytes = 32000

  // RIFF Chunk Descriptor
  header[0] = 'R'; header[1] = 'I'; header[2] = 'F'; header[3] = 'F';
  header[4] = (byte)(totalFileLen & 0xff);
  header[5] = (byte)((totalFileLen >> 8) & 0xff);
  header[6] = (byte)((totalFileLen >> 16) & 0xff);
  header[7] = (byte)((totalFileLen >> 24) & 0xff);
  header[8] = 'W'; header[9] = 'A'; header[10] = 'V'; header[11] = 'E';

  // "fmt " Sub-chunk
  header[12] = 'f'; header[13] = 'm'; header[14] = 't'; header[15] = ' ';
  header[16] = 16; header[17] = 0; header[18] = 0; header[19] = 0; // Subchunk1Size (16 for PCM)
  header[20] = 1; header[21] = 0; // AudioFormat (1 = PCM)
  header[22] = 1; header[23] = 0; // NumChannels (1 = Mono)
  header[24] = (byte)(SAMPLE_RATE & 0xff);
  header[25] = (byte)((SAMPLE_RATE >> 8) & 0xff);
  header[26] = (byte)((SAMPLE_RATE >> 16) & 0xff);
  header[27] = (byte)((SAMPLE_RATE >> 24) & 0xff);
  header[28] = (byte)(byteRate & 0xff);
  header[29] = (byte)((byteRate >> 8) & 0xff);
  header[30] = (byte)((byteRate >> 16) & 0xff);
  header[31] = (byte)((byteRate >> 24) & 0xff);
  header[32] = 2; header[33] = 0; // BlockAlign (channels * bits/sample / 8)
  header[34] = 16; header[35] = 0; // BitsPerSample (16 bits)

  // "data" Sub-chunk
  header[36] = 'd'; header[37] = 'a'; header[38] = 't'; header[39] = 'a';
  header[40] = (byte)(totalDataLen & 0xff);
  header[41] = (byte)((totalDataLen >> 8) & 0xff);
  header[42] = (byte)((totalDataLen >> 16) & 0xff);
  header[43] = (byte)((totalDataLen >> 24) & 0xff);
}

// ======================== HELPER FUNCTIONS ========================
String lcdSafe(String s, size_t n = 16) {
  s.replace("\r", "");
  s.replace("\n", " ");
  if (s.length() > n) s = s.substring(0, n);
  return s;
}

void showLCD(String a, String b) {
  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print(lcdSafe(a));
  lcd.setCursor(0, 1);
  lcd.print(lcdSafe(b));
}

void setStandbyScreen() {
  currentState = STATE_STANDBY;
  digitalWrite(GREEN_LED_PIN, LOW); // Ensure Green LED is OFF during standby
  showLCD("Room Track Bot", "Step Forward");
}

unsigned long getTrackDuration(uint16_t t) {
  switch (t) {
    case 1:  return 4200; // Welcome English: "Please speak patient name"
    case 2:  return 4500; // Welcome Tamil: "தயவுசெய்து நபரின் பெயரை கூறவும்"
    case 5:  return 2856; // Thank you English
    case 7:  return 3800; // Person not found Tamil

    case 10: return 1224; // First Floor English
    case 11: return 1272; // Second Floor English
    case 12: return 1152; // Third Floor English
    case 13: return 1200; // Fourth Floor English
    case 14: return 1200; // Fifth Floor English

    case 20: return 1104; // Room Number English

    case 30: return 1368; // First Floor Tamil
    case 31: return 1512; // Second Floor Tamil
    case 32: return 1560; // Third Floor Tamil
    case 33: return 1608; // Fourth Floor Tamil
    case 34: return 1440; // Fifth Floor Tamil

    case 40: return 1128; // Arai En Tamil

    default:
      if (t >= 101 && t <= 505) return 1500;
      if (t >= 1101 && t <= 1505) return 2000;
      return 1500;
  }
}

void playTrack(uint16_t t) {
  if (!playerReady) {
    Serial.println("WARN: DFPlayer not ready!");
    return;
  }

  unsigned long duration = getTrackDuration(t);
  Serial.printf("Playing track %04d for %lu ms\n", t, duration);
  player.playMp3Folder(t);
  delay(duration + 150);
}

int digitTrack(char c, bool tamil) {
  if (c < '0' || c > '9') return 0;
  return (tamil ? 60 : 50) + (c - '0');
}

int floorIndex(String floor) {
  floor.toUpperCase();
  if (floor == "1F") return 0;
  if (floor == "2F") return 1;
  if (floor == "3F") return 2;
  if (floor == "4F") return 3;
  if (floor == "5F") return 4;
  return 0;
}

void announceLocation(String floor, String room) {
  int f = floorIndex(floor);
  int roomNum = room.toInt();

  // 1. English Announcement
  playTrack(10 + f);
  playTrack(20);
  if (roomNum >= 101 && roomNum <= 505) {
    playTrack(roomNum);
  } else {
    for (size_t i = 0; i < room.length(); i++) {
      if (isDigit(room[i])) playTrack(digitTrack(room[i], false));
    }
  }

  // 2. Tamil Announcement
  playTrack(30 + f);
  playTrack(40);
  if (roomNum >= 101 && roomNum <= 505) {
    playTrack(1000 + roomNum);
  } else {
    for (size_t i = 0; i < room.length(); i++) {
      if (isDigit(room[i])) playTrack(digitTrack(room[i], true));
    }
  }
}

// Handle Patient Found
void handlePatientFound(JsonObject p) {
  String name   = String((const char*)(p["name"]        | "PATIENT"));
  String floor  = String((const char*)(p["floor"]       | ""));
  String room   = String((const char*)(p["room"]        | ""));
  String father = String((const char*)(p["father_name"] | ""));
  String city   = String((const char*)(p["city"]        | ""));

  Serial.println(">>> Patient Found: " + name + (father.length() > 0 ? " (S/O " + father + ")" : "") + (city.length() > 0 ? " [" + city + "]" : "") + " | Floor: " + floor + " | Room: " + room);
  
  // Display result on LCD
  showLCD(name, floor + " Room:" + room);
  announceLocation(floor, room);
  delay(2500);

  // Thank You screen
  showLCD("Thank You!", "Take Care");
  playTrack(5); // 0005.mp3: Thank you
  delay(2000);

  // Set cooldown to allow visitor to leave
  cooldownEndTime = millis() + COOLDOWN_DURATION_MS;
  setStandbyScreen();
}

// Ultrasonic distance measurement (cm)
long getDistanceCm() {
  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(2);
  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);

  long duration = pulseIn(ECHO_PIN, HIGH, 25000);
  if (duration == 0) return 999;
  return (duration * 0.034) / 2;
}

// ======================== VOICE RECORDING & SEARCH ========================
void recordAndSearchVoice() {
  if (!i2sReady) {
    Serial.println("ERROR: I2S is not initialized!");
    showLCD("Mic Error", "Not Configured");
    delay(2000);
    setStandbyScreen();
    return;
  }

  // Flush previous DMA buffer
  i2s_zero_dma_buffer(I2S_PORT);

  // Turn ON Green LED immediately when recording begins
  digitalWrite(GREEN_LED_PIN, HIGH);
  showLCD("Speak Name Now!", ">>> LISTENING <<<");
  Serial.println("\n[Voice Recording] Listening for 3 seconds...");

  // Allocate audio buffer for 16-bit PCM samples
  int16_t* audioBuffer = (int16_t*) malloc(WAV_DATA_SIZE);
  if (!audioBuffer) {
    digitalWrite(GREEN_LED_PIN, LOW);
    Serial.println("ERROR: Not enough memory for audio buffer!");
    showLCD("Memory Error", "Out of RAM");
    delay(2000);
    setStandbyScreen();
    return;
  }

  // Record stereo samples from INMP441, auto-detect active channel per sample, remove DC offset
  size_t bytesRead = 0;
  int samplesRecorded = 0;
  const int CHUNK_SAMPLES = 256;
  int32_t chunk32[CHUNK_SAMPLES];
  int32_t peakVolume = 0;
  int32_t dcAvg = 0;
  unsigned long recordStart = millis();

  while (samplesRecorded < NUM_SAMPLES) {
    i2s_read(I2S_PORT, chunk32, CHUNK_SAMPLES * sizeof(int32_t), &bytesRead, portMAX_DELAY);
    int readSamples = bytesRead / sizeof(int32_t);

    for (int i = 0; i < readSamples - 1 && samplesRecorded < NUM_SAMPLES; i += 2) {
      int32_t s0 = chunk32[i];
      int32_t s1 = chunk32[i + 1];
      // Auto-pick whichever stereo channel contains the microphone signal
      int32_t raw = (abs(s0) > abs(s1)) ? s0 : s1;

      // Remove DC offset using running average
      dcAvg += (raw - dcAvg) >> 5;
      int32_t centered = raw - dcAvg;

      // INMP441 24-bit audio is MSB-aligned in 32-bit slot (bits 31..8).
      // >> 12 converts 24-bit MSB to 16-bit PCM with optimal gain (+6dB boost for speaking 15-30cm)
      int32_t scaled = centered >> 12;
      if (scaled > 32767) scaled = 32767;
      if (scaled < -32768) scaled = -32768;

      int16_t sample16 = (int16_t)scaled;
      audioBuffer[samplesRecorded++] = sample16;

      int absVal = abs((int)sample16);
      if (absVal > peakVolume) peakVolume = absVal;
    }
  }

  unsigned long recordDuration = millis() - recordStart;
  Serial.printf(">>> Recorded %d samples in %lu ms. Audio Peak Level: %d / 32767\n", samplesRecorded, recordDuration, peakVolume);

  // Turn OFF Green LED when recording finishes
  digitalWrite(GREEN_LED_PIN, LOW);

  // Guard against silence: if peak volume is under 150, visitor did not speak
  if (peakVolume < 150) {
    Serial.println(">>> [WARNING] Audio is silent (peak < 150)! Visitor did not speak or was too quiet.");
    showLCD("No Voice Heard!", "Speak Louder...");
    playTrack(7); // Track 0007.mp3: Not found / prompt
    delay(2200);
    free(audioBuffer);
    currentState = STATE_WAITING_FOR_BUTTON;
    buttonWaitStart = millis();
    showLCD("Press Button To", "Try Again...");
    return;
  }

  showLCD("Searching...", "Processing Voice");

  // Transmit WAV audio via HTTP POST to /api/device/voice-search using streaming WiFiClient
  if (WiFi.status() == WL_CONNECTED) {
    String host; int port; String path;
    parseUrl(API_BASE, host, port, path);
    String fullPath = path + "/device/voice-search";

    WiFiClient client;
    client.setTimeout(HTTP_TIMEOUT_MS / 1000);

    Serial.printf("Connecting to %s:%d to send voice audio...\n", host.c_str(), port);
    IPAddress srvIp;
    bool connected = false;
    if (srvIp.fromString(host)) {
      connected = client.connect(srvIp, port);
    } else {
      connected = client.connect(host.c_str(), port);
    }
    if (connected) {
      String boundary = "----ESP32Boundary" + String(millis());
      String head = "--" + boundary + "\r\n" +
                    "Content-Disposition: form-data; name=\"audio\"; filename=\"audio.wav\"\r\n" +
                    "Content-Type: audio/wav\r\n\r\n";
      String tail = "\r\n--" + boundary + "--\r\n";

      byte wavHeader[WAV_HEADER_SIZE];
      createWavHeader(wavHeader, WAV_DATA_SIZE);

      int totalPayloadSize = head.length() + WAV_HEADER_SIZE + WAV_DATA_SIZE + tail.length();

      client.println("POST " + fullPath + " HTTP/1.1");
      client.println("Host: " + host + ":" + String(port));
      client.println("X-API-Key: " + String(API_KEY));
      client.println("Content-Type: multipart/form-data; boundary=" + boundary);
      client.println("Content-Length: " + String(totalPayloadSize));
      client.println("Connection: close");
      client.println();

      client.print(head);
      client.write(wavHeader, WAV_HEADER_SIZE);

      // Stream audio buffer in 1KB chunks
      const size_t CHUNK = 1024;
      for (size_t offset = 0; offset < WAV_DATA_SIZE; offset += CHUNK) {
        size_t toWrite = ((WAV_DATA_SIZE - offset) < CHUNK) ? (WAV_DATA_SIZE - offset) : CHUNK;
        client.write(((uint8_t*)audioBuffer) + offset, toWrite);
      }

      client.print(tail);
      client.flush();

      // Read HTTP response with timeout
      unsigned long t0 = millis();
      while (!client.available() && millis() - t0 < 8000) {
        delay(20);
      }

      String resBody = "";
      bool isBody = false;
      while (client.connected() || client.available()) {
        if (client.available()) {
          String line = client.readStringUntil('\n');
          if (!isBody) {
            line.trim();
            if (line.length() == 0) isBody = true;
          } else {
            resBody += line + "\n";
          }
        }
      }
      client.stop();
      resBody.trim();

      Serial.println("Voice Search Response: " + resBody);

      JsonDocument doc;
      if (deserializeJson(doc, resBody) == DeserializationError::Ok) {
        if ((bool)(doc["success"] | false)) {
          JsonObject p = doc["patient"].as<JsonObject>();
          String heardName = String((const char*)(doc["transcribed_name"] | ""));
          Serial.println("Whisper Understood: " + heardName);
          handlePatientFound(p);
          free(audioBuffer);
          return;
        } else {
          String heard = String((const char*)(doc["transcribed_name"] | ""));
          Serial.println("Whisper Understood: '" + heard + "' - Patient Not Found");
          if (heard.length() > 0) {
            showLCD("Heard: " + heard.substring(0, 9), "Patient Not Found");
          } else {
            showLCD("Patient Not", "Found!");
          }
          playTrack(7); // Track 0007.mp3: Not found
          delay(2500);

          // Requirement 4: Person not found -> Return to button input prompt
          free(audioBuffer);
          currentState = STATE_WAITING_FOR_BUTTON;
          buttonWaitStart = millis();
          showLCD("Press Button To", "Try Again...");
          Serial.println(">>> Patient Not Found: Returned to button prompt for another try.");
          return;
        }
      } else {
        Serial.println("Voice JSON parse failed or empty response!");
        showLCD("Voice Server", "Invalid Response");
        delay(2000);
      }
    } else {
      Serial.println("ERROR: Could not connect to backend server!");
      showLCD("Server Connect", "Failed");
      delay(2000);
    }
  } else {
    showLCD("WiFi Error", "Not Connected");
    delay(2000);
  }

  free(audioBuffer);
  currentState = STATE_WAITING_FOR_BUTTON;
  buttonWaitStart = millis();
  showLCD("Press Button To", "Try Again...");
}

// UDP Auto-Discovery of Backend Server IP
void discoverServerIP() {
  Serial.println("\n[Auto-Discovery] Searching for Laptop Server on Wi-Fi...");
  showLCD("Finding Server", "Auto-Discovery..");

  udpDiscovery.begin(4002);

  for (int attempt = 1; attempt <= 5; attempt++) {
    udpDiscovery.beginPacket(IPAddress(255, 255, 255, 255), 4001);
    udpDiscovery.print("DISCOVER_ROOM_TRACK_BOT");
    udpDiscovery.endPacket();

    IPAddress bIP = WiFi.broadcastIP();
    if (bIP) {
      udpDiscovery.beginPacket(bIP, 4001);
      udpDiscovery.print("DISCOVER_ROOM_TRACK_BOT");
      udpDiscovery.endPacket();
    }

    unsigned long startWait = millis();
    while (millis() - startWait < 300) {
      int packetSize = udpDiscovery.parsePacket();
      if (packetSize > 0) {
        char buf[64];
        int len = udpDiscovery.read(buf, sizeof(buf) - 1);
        if (len > 0) buf[len] = '\0';

        if (String(buf).indexOf("RTB_SERVER_ACK") >= 0) {
          IPAddress sIP = udpDiscovery.remoteIP();
          API_BASE = "http://" + sIP.toString() + ":4000/api";
          Serial.println(">>> [Auto-Discovery SUCCESS] Found Laptop Server at: " + API_BASE);
          showLCD("Server Found!", sIP.toString());
          delay(1200);
          udpDiscovery.stop();
          return;
        }
      }
      delay(10);
    }
    Serial.print(".");
  }

  Serial.println("\n[Auto-Discovery] Timeout: Using default IP: " + API_BASE);
  udpDiscovery.stop();
}

void ensureWiFiConnected() {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("Wi-Fi disconnected. Reconnecting...");
    WiFi.disconnect();
    WiFi.reconnect();
    delay(300);
    if (WiFi.status() == WL_CONNECTED) {
      discoverServerIP();
    }
  }
}

void connectWiFi() {
  Serial.println("\n--- Connecting to Wi-Fi ---");
  Serial.print("Target SSID: "); Serial.println(WIFI_SSID);

  showLCD("Connecting WiFi", WIFI_SSID);

  WiFi.disconnect(true);
  delay(500);
  WiFi.mode(WIFI_STA);
  delay(100);
  WiFi.setSleep(false);

  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 15000) {
    delay(300);
    Serial.print(".");
  }
  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println(">>> WiFi Connected! IP: " + WiFi.localIP().toString());
    showLCD("WiFi Connected!", WiFi.localIP().toString());
    delay(1000);
    discoverServerIP();
  } else {
    Serial.println(">>> WiFi Failed to connect! Check Hotspot settings.");
    showLCD("WiFi Failed", "Check Hotspot");
    delay(1200);
  }
}

// Heartbeat every 5s
void sendHeartbeat() {
  if (WiFi.status() != WL_CONNECTED) return;
  WiFiClient client;
  WiFiClientSecure secureClient;
  HTTPClient h;
  h.setTimeout(HTTP_TIMEOUT_MS);
  String url = String(API_BASE) + "/device/heartbeat";

  bool begun = url.startsWith("https://") ? (secureClient.setInsecure(), h.begin(secureClient, url)) : h.begin(client, url);

  if (begun) {
    h.addHeader("Content-Type", "application/json");
    h.addHeader("X-API-Key", API_KEY);
    String b = "{\"ip_address\":\"" + WiFi.localIP().toString() + "\"}";
    h.POST(b);
    h.end();
  }
}

// Poll website visitor dispatch every 2s
void pollWebsiteDispatch() {
  if (WiFi.status() != WL_CONNECTED) return;
  WiFiClient client;
  WiFiClientSecure secureClient;
  HTTPClient h;
  h.setTimeout(HTTP_TIMEOUT_MS);
  String url = String(API_BASE) + "/device/next-patient";

  bool begun = url.startsWith("https://") ? (secureClient.setInsecure(), h.begin(secureClient, url)) : h.begin(client, url);

  if (!begun) return;
  h.addHeader("X-API-Key", API_KEY);

  int code = h.GET();
  if (code == 200) {
    String body = h.getString();
    JsonDocument doc;
    if (deserializeJson(doc, body) == DeserializationError::Ok && ((bool)(doc["pending"] | false))) {
      JsonObject p = doc["patient"].as<JsonObject>();
      handlePatientFound(p);
    }
  }
  h.end();
}

// ======================== SETUP ========================
void setup() {
  Serial.begin(115200);

  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);

  pinMode(GREEN_LED_PIN, OUTPUT);
  digitalWrite(GREEN_LED_PIN, LOW); // Start with Green LED OFF

  pinMode(BUTTON_PIN, INPUT_PULLUP); // Push Button on GPIO 23 to GND

  Wire.begin(21, 22);
  lcd.init();
  lcd.backlight();
  showLCD("Room Track Bot", "Starting...");

  Serial.println("\nInitializing DFPlayer Mini...");
  dfSerial.begin(9600, SERIAL_8N1, DF_RX_PIN, DF_TX_PIN);
  delay(1200);

  playerReady = player.begin(dfSerial, false, false);
  if (!playerReady) {
    delay(500);
    playerReady = player.begin(dfSerial);
  }

  if (playerReady) {
    Serial.println(">>> DFPlayer Mini Online!");
    player.volume(DF_VOLUME);
    delay(200);
  }

  // Initialize INMP441 Microphone via I2S
  initI2S();

  connectWiFi();

  setStandbyScreen();
}

// ======================== LOOP ========================
void loop() {
  unsigned long currentMillis = millis();

  // 1. Check ultrasonic sensor when cooldown has passed
  if (currentMillis >= cooldownEndTime) {
    long distance = getDistanceCm();

    // In STANDBY: Detect person approaching (< 40cm)
    if (currentState == STATE_STANDBY) {
      if (distance > 0 && distance < 40) {
        currentState = STATE_CONFIRMING_PERSON;
        personDetectionStart = millis();
        showLCD("Person Detected", "Please Wait...");
        Serial.println("Person detected (< 40cm). Confirming...");
      }
    }
    // In CONFIRMING: Confirm person stayed for 500ms
    else if (currentState == STATE_CONFIRMING_PERSON) {
      if (distance > 0 && distance < 45) {
        if (currentMillis - personDetectionStart >= 500) {
          // Requirement 1: Welcome to Room Track Bot screen and voice output
          Serial.println(">>> Person Confirmed! Playing Welcome Screen & Voice...");
          showLCD("Welcome to", "Room Track Bot");
          playTrack(1); // Track 1: Welcome voice message
          delay(getTrackDuration(1)); // Wait for welcome audio to finish

          // Requirement 2: Prompt user to press button for voice input
          currentState = STATE_WAITING_FOR_BUTTON;
          buttonWaitStart = millis();
          showLCD("Press Button To", "Speak Name...");
          Serial.println(">>> Ready: Press button on GPIO 23 to speak!");
        }
      } else {
        // False alarm / person moved away quickly
        setStandbyScreen();
      }
    }
    // In WAITING_FOR_BUTTON: Check if push button is pressed
    else if (currentState == STATE_WAITING_FOR_BUTTON) {
      // Check push button (active LOW with internal pull-up on GPIO 23)
      if (digitalRead(BUTTON_PIN) == LOW) {
        Serial.println(">>> Push Button Pressed! Starting voice recording...");
        delay(150); // Debounce
        while (digitalRead(BUTTON_PIN) == LOW) delay(10); // Wait for release

        currentState = STATE_RECORDING;
        recordAndSearchVoice();
      }
      // Timeout: If visitor walked away (> 80cm) for 20 seconds without pressing button
      else if ((distance > 80 || distance == 999) && (currentMillis - buttonWaitStart >= 20000)) {
        Serial.println(">>> Button wait timeout (visitor left). Returning to standby.");
        setStandbyScreen();
      }
    }
  }

  // 2. Wi-Fi auto-reconnect
  if (WiFi.status() != WL_CONNECTED) {
    ensureWiFiConnected();
  }

  // 3. Website polling and heartbeat during standby or button wait
  if (currentState == STATE_STANDBY || currentState == STATE_WAITING_FOR_BUTTON) {
    if (millis() - lastPoll >= POLL_INTERVAL_MS) {
      lastPoll = millis();
      pollWebsiteDispatch();
    }

    if (millis() - lastHeartbeat >= HEARTBEAT_INTERVAL_MS) {
      lastHeartbeat = millis();
      sendHeartbeat();
    }
  }

  delay(25);
}
