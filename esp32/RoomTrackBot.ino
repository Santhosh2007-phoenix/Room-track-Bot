/*
  =============================================================================
  ROOM TRACK BOT - Complete ESP32 Firmware (Direct Port 4000 High-Speed Setup)
  =============================================================================
  Features:
  1. PERSON DETECTION:
     - Ultrasonic sensor detects person (< 40cm) continuously for 500ms.
     - LCD displays "Person Detected", then "Welcome! Send Name on BT" + voice greeting.
  2. BLUETOOTH TERMINAL SEARCH:
     - Connect via "Serial Bluetooth Terminal" app to "Room_Track_Bot".
     - Type patient name -> searches Supabase database instantly via local Express server!
     - Found: Displays on LCD + Speaks Floor & Room (English & Tamil) for 3s.
     - Displays "Thank You!" and "Next person soon" for 3s.
     - Not Found: Displays "Patient Not Found", allows another name.
  3. WEBSITE VISITOR SYNC:
     - When someone clicks "SEND TO ROOM TRACK BOT" on phone website,
       ESP32 receives it, shows on LCD, and announces in voice!
  4. DIRECT EXPRESS PORT 4000:
     - Bypasses Vite dev proxy directly to Node backend on Port 4000 -> 100% reliable!

  Pin Setup:
  - LCD I2C: SDA -> GPIO 21, SCL -> GPIO 22 (Address: 0x27)
  - Ultrasonic: TRIG -> GPIO 5, ECHO -> GPIO 18 (via voltage divider)
  - DFPlayer Mini: RX -> GPIO 16, TX -> GPIO 17 (via 1k resistor)
  - Bluetooth: Built-in ESP32 (Name: "Room_Track_Bot")
  - GND: Common Ground
  =============================================================================
*/

#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <Wire.h>
#include <LiquidCrystal_I2C.h>
#include <DFRobotDFPlayerMini.h>
#include <HardwareSerial.h>
#include "BluetoothSerial.h"

#if !defined(CONFIG_BT_ENABLED) || !defined(CONFIG_BLUEDROID_ENABLED)
#error Bluetooth is not enabled! Please check your board settings.
#endif

BluetoothSerial SerialBT;

// ======================== WI-FI CONFIGURATION ========================
const char* WIFI_SSID     = "Santhosh";       // Your Hotspot SSID
const char* WIFI_PASSWORD = "0987654321";   // Your Hotspot Password

// Direct Node.js Backend API on Port 4000 (Instant 10ms Response)
const char* API_BASE     = "http://10.34.106.79:4000/api";
const char* API_KEY      = "esp32-room-track-bot-secret-key-32chars";

// ======================== PIN ASSIGNMENTS ========================
static const int TRIG_PIN  = 5;
static const int ECHO_PIN  = 18;
static const int DF_RX_PIN = 16; // ESP32 RX (connect to DFPlayer TX)
static const int DF_TX_PIN = 17; // ESP32 TX (connect to DFPlayer RX via 1k resistor)

static const uint8_t LCD_ADDR = 0x27;
static const int DF_VOLUME = 20; // Max volume (0 to 30)

// Workflow Timing Constants
static const unsigned long POLL_INTERVAL_MS      = 2000;  // Poll website every 2s
static const unsigned long HEARTBEAT_INTERVAL_MS = 5000;  // Heartbeat every 5s
static const unsigned long IDLE_TIMEOUT_MS       = 20000; // Idle reset after 20s
static const unsigned long COOLDOWN_DURATION_MS  = 5000;  // 5-second cooldown
static const unsigned long HTTP_TIMEOUT_MS       = 5000;  // 5s timeout

LiquidCrystal_I2C lcd(LCD_ADDR, 16, 2);
HardwareSerial dfSerial(2);
DFRobotDFPlayerMini player;

bool playerReady = false;
unsigned long lastPoll = 0;
unsigned long lastHeartbeat = 0;
unsigned long lastActivityTime = 0;
unsigned long cooldownEndTime = 0;

// State Machine
enum BotState {
  STATE_STANDBY,
  STATE_CONFIRMING_PERSON,
  STATE_AWAITING_INPUT
};

BotState currentState = STATE_STANDBY;
unsigned long personDetectionStart = 0;

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
  showLCD("Room Track Bot", "BT: Ready");
  lastActivityTime = millis();
}

unsigned long getTrackDuration(uint16_t t) {
  switch (t) {
    case 1:  return 4824;
    case 2:  return 4608;
    case 5:  return 2688;
    case 7:  return 5088;

    case 10: return 1488;
    case 11: return 1728;
    case 12: return 1848;
    case 13: return 1968;

    case 20: return 1728;

    case 30: return 1608;
    case 31: return 1848;
    case 32: return 1848;
    case 33: return 1704;

    case 40: return 1368;

    case 50: return 1608;
    case 51: return 1248;
    case 52: return 1104;
    case 53: return 1248;
    case 54: return 1416;
    case 55: return 1416;
    case 56: return 1368;
    case 57: return 1344;
    case 58: return 1968;
    case 59: return 1248;

    case 60: return 1464;
    case 61: return 1368;
    case 62: return 1296;
    case 63: return 1224;
    case 64: return 1368;
    case 65: return 1224;
    case 66: return 1128;
    case 67: return 1416;
    case 68: return 1464;
    case 69: return 1296;

    default:
      if (t >= 101 && t <= 505) return 1600;   // English: "Two not one"
      if (t >= 1101 && t <= 1505) return 2100; // Tamil: "இருநூற்று ஒன்று"
      return 2000;
  }
}

void playTrack(uint16_t t) {
  if (!playerReady) {
    Serial.println("ERROR: DFPlayer not ready!");
    return;
  }

  unsigned long duration = getTrackDuration(t);

  Serial.printf("Playing track %04d for %lu ms\n",
                t, duration);

  player.playMp3Folder(t);

  // Wait until the audio duration plus 200 ms safety margin
  delay(duration + 200);
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
  return 0;
}

void announceLocation(String floor, String room) {
  int f = floorIndex(floor);
  int roomNum = room.toInt();

  // 1. English: Second Floor, Room Number, Two not one
  playTrack(10 + f);
  playTrack(20);
  if (roomNum >= 101 && roomNum <= 505) {
    playTrack(roomNum); // Plays e.g. 0201.mp3
  } else {
    for (size_t i = 0; i < room.length(); i++) {
      if (isDigit(room[i])) playTrack(digitTrack(room[i], false));
    }
  }

  // 2. Tamil: இரண்டாம் தளம், அறை எண், இருநூற்று ஒன்று
  playTrack(30 + f);
  playTrack(40);
  if (roomNum >= 101 && roomNum <= 505) {
    playTrack(1000 + roomNum); // Plays e.g. 1201.mp3
  } else {
    for (size_t i = 0; i < room.length(); i++) {
      if (isDigit(room[i])) playTrack(digitTrack(room[i], true));
    }
  }
}

// Handle Patient Found
void handlePatientFound(JsonObject p) {
  String name  = String((const char*)(p["name"]  | "PATIENT"));
  String floor = String((const char*)(p["floor"] | ""));
  String room  = String((const char*)(p["room"]  | ""));

  Serial.println(">>> Patient Found: " + name + " | Floor: " + floor + " | Room: " + room);
  
  // Show result for 3 seconds
  showLCD(name, floor + " Room:" + room);
  announceLocation(floor, room);
  delay(3000);

  // Display 'Thank You!' and 'Next person soon' for 3 seconds
  showLCD("Thank You!", "Next person soon");
  playTrack(5); // 0005.mp3: Thank you
  delay(3000);

  // 5-second cooldown
  cooldownEndTime = millis() + COOLDOWN_DURATION_MS;
  
  // Return to standby screen
  setStandbyScreen();
}

// Ultrasonic distance measurement (cm)
long getDistanceCm() {
  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(2);
  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);

  long duration = pulseIn(ECHO_PIN, HIGH, 30000);
  if (duration == 0) return 999;
  return (duration * 0.034) / 2;
}

String urlEncode(String str) {
  String encoded = "";
  for (size_t i = 0; i < str.length(); i++) {
    char c = str.charAt(i);
    if (isalnum(c)) {
      encoded += c;
    } else if (c == ' ') {
      encoded += "%20";
    } else {
      char buf[4];
      sprintf(buf, "%%%02X", c);
      encoded += buf;
    }
  }
  return encoded;
}

// Search Patient
void searchPatient(String patientName) {
  patientName.trim();
  if (patientName.length() == 0) return;

  lastActivityTime = millis();
  Serial.println("Searching Patient: " + patientName);
  SerialBT.println("Searching for: " + patientName + "...");

  showLCD("Searching...", patientName);

  if (WiFi.status() == WL_CONNECTED) {
    WiFiClient client;
    HTTPClient http;
    http.setTimeout(HTTP_TIMEOUT_MS);
    String url = String(API_BASE) + "/visitor/search?name=" + urlEncode(patientName);

    if (http.begin(client, url)) {
      int httpCode = http.GET();
      if (httpCode == 200) {
        String res = http.getString();
        Serial.println("Search Response: " + res);

        JsonDocument doc;
        if (deserializeJson(doc, res) == DeserializationError::Ok) {
          if ((bool)(doc["found"] | false)) {
            JsonObject p = doc["patient"].as<JsonObject>();
            String pName = String((const char*)(p["name"] | ""));
            String pFloor = String((const char*)(p["floor"] | ""));
            String pRoom = String((const char*)(p["room"] | ""));

            SerialBT.println("================================");
            SerialBT.println(">>> PATIENT FOUND!");
            SerialBT.println("Name  : " + pName);
            SerialBT.println("Floor : " + pFloor);
            SerialBT.println("Room  : " + pRoom);
            SerialBT.println("================================");

            handlePatientFound(p);
            return;
          } else {
            SerialBT.println(">>> Patient '" + patientName + "' Not Found! Please send another name:");
            showLCD("Patient Not", "Found!");
            playTrack(7);
            delay(2500);

            showLCD("Send Name on BT", "Try Again...");
            currentState = STATE_AWAITING_INPUT;
            lastActivityTime = millis();
            return;
          }
        }
      } else {
        SerialBT.println(">>> Server Error Code: " + String(httpCode));
        showLCD("Server Error", "Code: " + String(httpCode));
        delay(2000);
        setStandbyScreen();
      }
      http.end();
    }
  } else {
    SerialBT.println(">>> Wi-Fi Error: Not Connected to Server!");
    showLCD("WiFi Error", "Not Connected");
    delay(2000);
    setStandbyScreen();
  }
}

void ensureWiFiConnected() {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("Wi-Fi disconnected. Reconnecting...");
    WiFi.disconnect();
    WiFi.reconnect();
    delay(300);
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
    delay(1200);
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
  HTTPClient h;
  h.setTimeout(HTTP_TIMEOUT_MS);
  String url = String(API_BASE) + "/device/heartbeat";
  if (h.begin(client, url)) {
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
  HTTPClient h;
  h.setTimeout(HTTP_TIMEOUT_MS);
  String url = String(API_BASE) + "/device/next-patient";
  if (!h.begin(client, url)) return;
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

// Setup
void setup() {
  Serial.begin(115200);

  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);

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

  connectWiFi();

  SerialBT.begin("Room_Track_Bot");
  Serial.println("Bluetooth Started! Device Name: Room_Track_Bot");

  setStandbyScreen();
}

void loop() {
  unsigned long currentMillis = millis();

  // 1. Check ultrasonic sensor first
  if (currentMillis >= cooldownEndTime) {
    long distance = getDistanceCm();

    if (distance > 0 && distance < 40) {
      if (currentState == STATE_STANDBY) {
        currentState = STATE_CONFIRMING_PERSON;
        personDetectionStart = millis();
        lastActivityTime = millis();

        showLCD("Person Detected", "Please Wait...");
        Serial.println("Person detected. Confirming...");
      }
      else if (currentState == STATE_CONFIRMING_PERSON) {
        if (currentMillis - personDetectionStart >= 500) {
          currentState = STATE_AWAITING_INPUT;
          lastActivityTime = millis();

          showLCD("Welcome!", "Send Name on BT");

          SerialBT.println(
            "Welcome to Room Track Bot. Please type person name:"
          );

          playTrack(1);
          playTrack(2);
        }
      }
    }
    else if (currentState == STATE_CONFIRMING_PERSON) {
      setStandbyScreen();
    }
  }

  // 2. Wi-Fi reconnect only when disconnected
  if (WiFi.status() != WL_CONNECTED) {
    ensureWiFiConnected();
  }

  // 3. Website polling and heartbeat during standby only
  if (currentState == STATE_STANDBY) {
    if (millis() - lastPoll >= POLL_INTERVAL_MS) {
      lastPoll = millis();
      pollWebsiteDispatch();
    }

    if (millis() - lastHeartbeat >= HEARTBEAT_INTERVAL_MS) {
      lastHeartbeat = millis();
      sendHeartbeat();
    }
  }

  // 4. Bluetooth name input
  if (SerialBT.available()) {
    String incomingName = SerialBT.readStringUntil('\n');
    incomingName.trim();

    if (incomingName.length() > 0) {
      searchPatient(incomingName);
    }
  }

  // 5. Idle timeout
  if (currentState != STATE_STANDBY &&
      millis() - lastActivityTime >= IDLE_TIMEOUT_MS) {
    Serial.println("Idle timeout: Returning to standby.");
    setStandbyScreen();
  }

  delay(25);
}
