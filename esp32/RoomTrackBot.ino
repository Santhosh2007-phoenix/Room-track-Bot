/*
  =============================================================================
  ROOM TRACK BOT - ESP32 Bluetooth Terminal + Wi-Fi + LCD + DFPlayer Firmware
  =============================================================================
  Features:
  1. BLUETOOTH TERMINAL INPUT:
     - Connect your phone using "Serial Bluetooth Terminal" app to "Room_Track_Bot".
     - Type patient name (e.g., "John") -> searches database -> shows on LCD & speaks!
     - Sends response back to your phone terminal!
  2. ULTRASONIC SENSOR:
     - Detects person walking up (< 40cm) and welcomes them on LCD.
  3. DFPLAYER MINI AUDIO:
     - Announces Floor & Room in English & Tamil!
  4. 16x2 I2C LCD:
     - Real-time location display.
  5. WEBSITE DISPATCH:
     - Automatically receives searches sent from website (/visitor).

  Pin Setup:
  - LCD: SDA -> GPIO 21, SCL -> GPIO 22
  - Ultrasonic: TRIG -> GPIO 5, ECHO -> GPIO 18 (via voltage divider)
  - DFPlayer: RX -> GPIO 17 (ESP32 RX), TX -> GPIO 16 (ESP32 TX to DFPlayer RX)
  - Bluetooth: Built-in ESP32 Bluetooth (Name: "Room_Track_Bot")
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

// Check Bluetooth support
#if !defined(CONFIG_BT_ENABLED) || !defined(CONFIG_BLUEDROID_ENABLED)
#error Bluetooth is not enabled! Please check your board settings.
#endif

BluetoothSerial SerialBT;

// ======================== WI-FI CONFIGURATION ========================
const char* WIFI_SSID     = "LUCIFER";       // Your Hotspot SSID
const char* WIFI_PASSWORD = "5544332211";   // Your Hotspot Password

// Backend Server IP & Port (Running on PC)
const char* API_BASE     = "http://10.34.106.79:4000/api";
const char* API_KEY      = "esp32-room-track-bot-secret-key-32chars";

// ======================== PIN ASSIGNMENTS ========================
static const int TRIG_PIN  = 5;
static const int ECHO_PIN  = 18;
static const int DF_RX_PIN = 17; // ESP32 RX (connect to DFPlayer TX)
static const int DF_TX_PIN = 16; // ESP32 TX (connect to DFPlayer RX via 1k resistor)

static const uint8_t LCD_ADDR = 0x27;
static const int DF_VOLUME = 25;
static const unsigned long POLL_INTERVAL_MS = 2000;
static const unsigned long HEARTBEAT_INTERVAL_MS = 20000;
static const unsigned long HTTP_TIMEOUT_MS = 6000;

LiquidCrystal_I2C lcd(LCD_ADDR, 16, 2);
HardwareSerial dfSerial(2);
DFRobotDFPlayerMini player;

bool playerReady = false;
unsigned long lastPoll = 0;
unsigned long lastHeartbeat = 0;
unsigned long lastPersonDetectedTime = 0;

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

void playTrack(uint16_t t) {
  if (playerReady) {
    player.playMp3Folder(t);
    delay(750);
  }
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

// Announcements in English & Tamil
void announceLocation(String floor, String room) {
  int f = floorIndex(floor);

  // English: [Floor] [Room number] [digits...]
  playTrack(10 + f);
  playTrack(20);
  for (size_t i = 0; i < room.length(); i++) {
    if (isDigit(room[i])) playTrack(digitTrack(room[i], false));
  }

  // Tamil: [Floor] [அறை எண்] [digits...]
  playTrack(30 + f);
  playTrack(40);
  for (size_t i = 0; i < room.length(); i++) {
    if (isDigit(room[i])) playTrack(digitTrack(room[i], true));
  }
}

void handlePatient(JsonObject p) {
  String name  = String((const char*)(p["name"]  | "PATIENT"));
  String floor = String((const char*)(p["floor"] | ""));
  String room  = String((const char*)(p["room"]  | ""));

  Serial.println(">>> Patient: " + name + " | Floor: " + floor + " | Room: " + room);
  showLCD(name, floor + " Room:" + room);
  announceLocation(floor, room);

  delay(1500);
  showLCD("Thank you.....", "");
  playTrack(5);
  delay(1500);
  showLCD("Room Track Bot", "BT: Ready");
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

// URL encode helper for patient names with spaces
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

// ======================== BLUETOOTH PATIENT SEARCH ========================
void searchPatientFromBluetooth(String patientName) {
  patientName.trim();
  if (patientName.length() == 0) return;

  Serial.println("Bluetooth search query: " + patientName);
  SerialBT.println("Searching for: " + patientName + "...");

  showLCD("Searching BT...", patientName);

  if (WiFi.status() == WL_CONNECTED) {
    HTTPClient http;
    http.setTimeout(HTTP_TIMEOUT_MS);
    String url = String(API_BASE) + "/visitor/search?name=" + urlEncode(patientName);

    if (http.begin(url)) {
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

            // Send back to Bluetooth app
            SerialBT.println("================================");
            SerialBT.println(">>> PATIENT FOUND!");
            SerialBT.println("Name  : " + pName);
            SerialBT.println("Floor : " + pFloor);
            SerialBT.println("Room  : " + pRoom);
            SerialBT.println("================================");

            // Trigger LCD + DFPlayer voice
            handlePatient(p);
            return;
          } else {
            SerialBT.println(">>> Patient '" + patientName + "' Not Found in Database!");
            showLCD(patientName, "Not Found!");
            playTrack(10); // Track 10: Not found
            delay(2000);
            showLCD("Room Track Bot", "BT: Ready");
            return;
          }
        }
      } else {
        SerialBT.println(">>> Error: Server returned code " + String(httpCode));
        showLCD("Server Error", "Code: " + String(httpCode));
        delay(1500);
        showLCD("Room Track Bot", "BT: Ready");
      }
      http.end();
    }
  } else {
    SerialBT.println(">>> Error: ESP32 WiFi is not connected to server!");
    showLCD("WiFi Error", "Not Connected");
    delay(1500);
    showLCD("Room Track Bot", "BT: Ready");
  }
}

// ======================== WI-FI OPERATIONS ========================
void connectWiFi() {
  Serial.println("\n--- Connecting to Wi-Fi ---");
  Serial.print("Target SSID: "); Serial.println(WIFI_SSID);

  showLCD("Connecting WiFi", WIFI_SSID);

  WiFi.disconnect(true);
  delay(500);
  WiFi.mode(WIFI_STA);
  delay(100);
  WiFi.setSleep(false); // Prevent WiFi power saving drops

  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  unsigned long start = millis();
  int dots = 0;
  while (WiFi.status() != WL_CONNECTED && millis() - start < 20000) {
    delay(500);
    Serial.print(".");
    dots++;
    if (dots % 4 == 0) {
      showLCD("Connecting WiFi", String(WIFI_SSID) + "..");
    }
  }
  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println(">>> WiFi Connected Successfully!");
    Serial.print("ESP32 IP Address: "); Serial.println(WiFi.localIP());
    showLCD("WiFi Connected!", WiFi.localIP().toString());
    delay(1500);
  } else {
    int st = WiFi.status();
    Serial.printf(">>> WiFi Connection FAILED! Status Code: %d\n", st);
    if (st == WL_NO_SSID_AVAIL) {
      Serial.println("ERROR: Hotspot SSID not found! Check if Hotspot AP Band is set to 2.4 GHz!");
      showLCD("Hotspot NotSeen", "Must use 2.4GHz");
    } else if (st == WL_CONNECT_FAILED) {
      Serial.println("ERROR: Password incorrect or connection rejected!");
      showLCD("WiFi Failed", "Wrong Password?");
    } else {
      Serial.println("ERROR: Connection timed out!");
      showLCD("WiFi Failed", "Status: " + String(st));
    }
    delay(2500);
  }
}

void heartbeat() {
  if (WiFi.status() != WL_CONNECTED) return;
  HTTPClient h;
  h.setTimeout(HTTP_TIMEOUT_MS);
  String url = String(API_BASE) + "/device/heartbeat";
  if (h.begin(url)) {
    h.addHeader("Content-Type", "application/json");
    h.addHeader("X-API-Key", API_KEY);
    String b = "{\"ip_address\":\"" + WiFi.localIP().toString() + "\"}";
    h.POST(b);
    h.end();
  }
}

void pollDispatch() {
  if (WiFi.status() != WL_CONNECTED) return;
  HTTPClient h;
  h.setTimeout(HTTP_TIMEOUT_MS);
  String url = String(API_BASE) + "/device/next-patient";
  if (!h.begin(url)) return;
  h.addHeader("X-API-Key", API_KEY);

  int code = h.GET();
  if (code == 200) {
    String body = h.getString();
    JsonDocument doc;
    if (deserializeJson(doc, body) == DeserializationError::Ok && ((bool)(doc["pending"] | false))) {
      JsonObject p = doc["patient"].as<JsonObject>();
      handlePatient(p);
    }
  }
  h.end();
}

// ======================== MAIN SETUP & LOOP ========================
void setup() {
  Serial.begin(115200);

  // Ultrasonic Pins
  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);

  // LCD Init (GPIO 21 SDA, GPIO 22 SCL)
  Wire.begin(21, 22);
  lcd.init();
  lcd.backlight();
  showLCD("Room Track Bot", "Starting...");

  // Setup DFPlayer (RX=GPIO 17, TX=GPIO 16)
  dfSerial.begin(9600, SERIAL_8N1, DF_RX_PIN, DF_TX_PIN);
  playerReady = player.begin(dfSerial, false, false);
  if (playerReady) player.volume(DF_VOLUME);

  // Connect Wi-Fi
  connectWiFi();

  // Start Bluetooth Serial
  SerialBT.begin("Room_Track_Bot"); // Bluetooth Name shown on phone
  Serial.println("Bluetooth Started! Connect to: Room_Track_Bot");

  if (playerReady) {
    playTrack(1); // Welcome English
    playTrack(2); // Welcome Tamil
  }

  showLCD("Room Track Bot", "BT: Ready");
}

void loop() {
  // Reconnect WiFi if lost
  if (WiFi.status() != WL_CONNECTED) {
    WiFi.reconnect();
    delay(200);
  }

  // 1. Bluetooth Input Processing (From "Serial Bluetooth Terminal" App)
  if (SerialBT.available()) {
    String command = SerialBT.readStringUntil('\n');
    command.trim();
    if (command.length() > 0) {
      searchPatientFromBluetooth(command);
    }
  }

  // 2. Poll dispatch queue from Website visitor page
  if (millis() - lastPoll >= POLL_INTERVAL_MS) {
    lastPoll = millis();
    pollDispatch();
  }

  // 3. Heartbeat to backend (Keep Dashboard "Online")
  if (millis() - lastHeartbeat >= HEARTBEAT_INTERVAL_MS) {
    lastHeartbeat = millis();
    heartbeat();
  }

  // 4. Ultrasonic Sensor Person Detection (< 40 cm)
  if (millis() - lastPersonDetectedTime > 5000) {
    long distance = getDistanceCm();
    if (distance > 2 && distance < 40) {
      Serial.printf("Person detected at %ld cm!\n", distance);
      lastPersonDetectedTime = millis();
      showLCD("Welcome!", "Send Name on BT");
      SerialBT.println("Hello! Please type patient name to search:");
      delay(2000);
      showLCD("Room Track Bot", "BT: Ready");
      lastPersonDetectedTime = millis();
    }
  }

  delay(20);
}
