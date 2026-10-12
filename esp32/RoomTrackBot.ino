/*
  =============================================================================
  ROOM TRACK BOT - Complete ESP32 Firmware (Exact 17-Step Workflow)
  =============================================================================
  Workflow Logic Implemented:
  1. Start the ESP32.
  2. Initialize LCD, Bluetooth, Wi-Fi, HC-SR04 sensor, DFPlayer, backend comms.
  3. Display "Room Track Bot" and "BT: Ready" on LCD.
  4. HC-SR04 detects person (2 cm to < 40 cm).
  5. Display "Person Detected" and "Please Wait..." on LCD.
  6. Wait 2 seconds to confirm person's presence.
  7. Display "Welcome!" and "Send Name on BT" on LCD (and plays Welcome audio).
  8. Receive person's name through Bluetooth mobile app.
  9. Send received name to online Patient Database API.
  10. Search for details in database:
      IF FOUND:
        * Display patient name on LCD.
        * Display floor number and room number.
        * Show result for 3 seconds (+ voice announcement).
        * Display "Thank You!" and "Next person soon" for 3 seconds.
      IF NOT FOUND:
        * Display patient-not-found message ("Patient Not Found", "Try Again").
        * Wait for another name through Bluetooth.
  11. After completing patient flow, activate 5-second cooldown.
  12. Return to initial screen ("Room Track Bot" / "BT: Ready") and re-enable HC-SR04.
  13. Check for pending website requests every 2 seconds.
  14. Send device heartbeat to backend every 5 seconds.
  15. Retry Wi-Fi connection periodically if disconnected.
  16. If no function or visitor flow active for 20 seconds, restore initial screen.
  17. Endless loop repeating for next visitor.

  Pin Setup:
  - LCD I2C: SDA -> GPIO 21, SCL -> GPIO 22 (Address: 0x27)
  - Ultrasonic: TRIG -> GPIO 5, ECHO -> GPIO 18 (via voltage divider)
  - DFPlayer Mini: RX -> GPIO 17, TX -> GPIO 16 (via 1k resistor)
  - Bluetooth: Built-in ESP32 (Name: "Room_Track_Bot")
  - GND: Common Ground
  =============================================================================
*/

#include <WiFi.h>
#include <WiFiClientSecure.h>
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

// Live Render Cloud Backend API
const char* API_BASE     = "https://room-track-bot-backend.onrender.com/api";
const char* API_KEY      = "esp32-room-track-bot-secret-key-32chars";

// ======================== PIN ASSIGNMENTS ========================
static const int TRIG_PIN  = 5;
static const int ECHO_PIN  = 18;
static const int DF_RX_PIN = 17; // ESP32 RX (connect to DFPlayer TX)
static const int DF_TX_PIN = 16; // ESP32 TX (connect to DFPlayer RX via 1k resistor)

static const uint8_t LCD_ADDR = 0x27;
static const int DF_VOLUME = 30; // Max volume (0 to 30)

// Workflow Timing Constants
static const unsigned long POLL_INTERVAL_MS      = 2000;  // Step 13: Poll website every 2s
static const unsigned long HEARTBEAT_INTERVAL_MS = 5000;  // Step 14: Heartbeat every 5s
static const unsigned long IDLE_TIMEOUT_MS       = 20000; // Step 16: Idle reset after 20s
static const unsigned long COOLDOWN_DURATION_MS  = 5000;  // Step 11: 5-second cooldown
static const unsigned long HTTP_TIMEOUT_MS       = 12000; // 12 seconds for cloud API

LiquidCrystal_I2C lcd(LCD_ADDR, 16, 2);
HardwareSerial dfSerial(2);
DFRobotDFPlayerMini player;

bool playerReady = false;
unsigned long lastPoll = 0;
unsigned long lastHeartbeat = 0;
unsigned long lastActivityTime = 0; // Tracks Step 16 idle timeout
unsigned long cooldownEndTime = 0;  // Tracks Step 11 cooldown

// State Machine for Detection & Visitor Flow
enum BotState {
  STATE_STANDBY,        // Step 3: "Room Track Bot" / "BT: Ready"
  STATE_CONFIRMING_PERSON, // Step 5 & 6: "Person Detected" / "Please Wait..."
  STATE_AWAITING_INPUT     // Step 7: "Welcome!" / "Send Name on BT"
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
  showLCD("Room Track Bot", "BT: Ready"); // Step 3 & 12
  lastActivityTime = millis();
}

void playTrack(uint16_t t) {
  Serial.printf(">>> Playing Track: %d (Player Ready: %s)\n", t, playerReady ? "YES" : "NO");
  if (playerReady) {
    player.play(t);          // Plays root /0001.mp3
    player.playMp3Folder(t); // Plays /MP3/0001.mp3
    delay(900);
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

void announceLocation(String floor, String room) {
  int f = floorIndex(floor);

  // 1. English: [Floor 0010..0013] [Room number 0020] [Digits 0050..0059]
  playTrack(10 + f);
  playTrack(20);
  for (size_t i = 0; i < room.length(); i++) {
    if (isDigit(room[i])) playTrack(digitTrack(room[i], false));
  }

  // 2. Tamil: [Floor 0030..0033] [அறை எண் 0040] [Digits 0060..0069]
  playTrack(30 + f);
  playTrack(40);
  for (size_t i = 0; i < room.length(); i++) {
    if (isDigit(room[i])) playTrack(digitTrack(room[i], true));
  }
}

// Step 10: Handle Patient Found
void handlePatientFound(JsonObject p) {
  String name  = String((const char*)(p["name"]  | "PATIENT"));
  String floor = String((const char*)(p["floor"] | ""));
  String room  = String((const char*)(p["room"]  | ""));

  Serial.println(">>> Patient Found: " + name + " | Floor: " + floor + " | Room: " + room);
  
  // Step 10: * Display the patient’s name on LCD
  //          * Display floor number and room number
  //          * Show the result for 3 seconds
  showLCD(name, floor + " Room:" + room);
  announceLocation(floor, room);
  delay(3000); // Show result for 3 seconds

  // Step 10: * Display 'Thank You!' and 'Next person soon' for 3 seconds
  showLCD("Thank You!", "Next person soon");
  playTrack(5); // 0005.mp3: Thank you
  delay(3000); // 3 seconds display

  // Step 11: After completing patient flow, activate a 5-second cooldown
  cooldownEndTime = millis() + COOLDOWN_DURATION_MS;
  
  // Step 12: Return to initial screen and enable HC-SR04 detection
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

// Step 9 & 10: Search Patient
void searchPatient(String patientName) {
  patientName.trim();
  if (patientName.length() == 0) return;

  lastActivityTime = millis();
  Serial.println("Searching Patient: " + patientName);
  SerialBT.println("Searching for: " + patientName + "...");

  showLCD("Searching...", patientName);

  if (WiFi.status() == WL_CONNECTED) {
    WiFiClientSecure secureClient;
    secureClient.setInsecure(); // Bypass SSL verification on ESP32

    HTTPClient http;
    http.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);
    http.setTimeout(HTTP_TIMEOUT_MS);
    String url = String(API_BASE) + "/visitor/search?name=" + urlEncode(patientName);

    if (http.begin(secureClient, url)) {
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

            // Execute Patient Found workflow
            handlePatientFound(p);
            return;
          } else {
            // Step 10: Patient Not Found flow
            // * Display a patient-not-found message
            // * Wait for another name through Bluetooth
            SerialBT.println(">>> Patient '" + patientName + "' Not Found in Database! Please send another name:");
            showLCD("Patient Not", "Found!");
            playTrack(7); // 0007.mp3: Patient not found
            delay(2500);

            // Return to awaiting another name
            showLCD("Send Name on BT", "Try Again...");
            currentState = STATE_AWAITING_INPUT;
            lastActivityTime = millis();
            return;
          }
        }
      } else {
        SerialBT.println(">>> Server Error Code: " + String(httpCode));
        Serial.printf("HTTP GET failed, error code: %d, errStr: %s\n", httpCode, http.errorToString(httpCode).c_str());
        showLCD("Server Error", "Code: " + String(httpCode));
        delay(2000);
        setStandbyScreen();
      }
      http.end();
    } else {
      SerialBT.println(">>> HTTPClient begin failed!");
      showLCD("Conn Failed", "Retry...");
      delay(2000);
      setStandbyScreen();
    }
  } else {
    SerialBT.println(">>> Wi-Fi Error: Not Connected to Online API!");
    showLCD("WiFi Error", "Not Connected");
    delay(2000);
    setStandbyScreen();
  }
}

// Step 15: Wi-Fi Reconnection Logic
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

// Step 14: Send device heartbeat to backend every 5 seconds
void sendHeartbeat() {
  if (WiFi.status() != WL_CONNECTED) return;
  WiFiClientSecure secureClient;
  secureClient.setInsecure();

  HTTPClient h;
  h.setTimeout(HTTP_TIMEOUT_MS);
  String url = String(API_BASE) + "/device/heartbeat";
  if (h.begin(secureClient, url)) {
    h.addHeader("Content-Type", "application/json");
    h.addHeader("X-API-Key", API_KEY);
    String b = "{\"ip_address\":\"" + WiFi.localIP().toString() + "\"}";
    h.POST(b);
    h.end();
  }
}

// Step 13: Check for pending website requests every 2 seconds
void pollWebsiteDispatch() {
  if (WiFi.status() != WL_CONNECTED) return;
  WiFiClientSecure secureClient;
  secureClient.setInsecure();

  HTTPClient h;
  h.setTimeout(HTTP_TIMEOUT_MS);
  String url = String(API_BASE) + "/device/next-patient";
  if (!h.begin(secureClient, url)) return;
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

// ======================== MAIN SETUP & LOOP ========================
// Step 1: Start the ESP32
void setup() {
  Serial.begin(115200);

  // Step 2: Initialize LCD, Bluetooth, Wi-Fi, HC-SR04, and DFPlayer
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

  // Initialize Wi-Fi
  connectWiFi();

  // Initialize Bluetooth
  SerialBT.begin("Room_Track_Bot");
  Serial.println("Bluetooth Started! Device Name: Room_Track_Bot");

  // Step 3: Display 'Room Track Bot' and 'BT: Ready' on the LCD
  setStandbyScreen();
}

void loop() {
  // Step 15: Retry Wi-Fi connection periodically if disconnected
  ensureWiFiConnected();

  unsigned long currentMillis = millis();

  // Step 13: Check for pending website requests every 2 seconds
  if (currentMillis - lastPoll >= POLL_INTERVAL_MS) {
    lastPoll = currentMillis;
    pollWebsiteDispatch();
  }

  // Step 14: Send the device heartbeat to the backend every 5 seconds
  if (currentMillis - lastHeartbeat >= HEARTBEAT_INTERVAL_MS) {
    lastHeartbeat = currentMillis;
    sendHeartbeat();
  }

  // Step 8: Receive person's name through Bluetooth mobile app
  if (SerialBT.available()) {
    String incomingName = SerialBT.readStringUntil('\n');
    incomingName.trim();
    if (incomingName.length() > 0) {
      searchPatient(incomingName); // Steps 9 & 10
    }
  }

  // Step 16: If no function or visitor flow is active for 20 seconds, restore initial screen
  if (currentState != STATE_STANDBY && (currentMillis - lastActivityTime >= IDLE_TIMEOUT_MS)) {
    Serial.println("Idle timeout (20s): Restoring initial screen.");
    setStandbyScreen();
  }

  // Steps 4 to 7: HC-SR04 Sensor Detection Logic (Active when not in cooldown)
  if (currentMillis > cooldownEndTime) {
    long distance = getDistanceCm();

    // Step 4: HC-SR04 sensor detects person within 2 cm to < 40 cm
    if (distance >= 2 && distance < 40) {
      if (currentState == STATE_STANDBY) {
        // Step 5: Display 'Person Detected' and 'Please Wait...' on the LCD
        currentState = STATE_CONFIRMING_PERSON;
        personDetectionStart = currentMillis;
        lastActivityTime = currentMillis;
        showLCD("Person Detected", "Please Wait...");
        Serial.printf("Person detected at %ld cm. Starting 2-second confirmation...\n", distance);
      } else if (currentState == STATE_CONFIRMING_PERSON) {
        // Step 6: Wait for 2 seconds to confirm the person’s presence
        if (currentMillis - personDetectionStart >= 2000) {
          // 2 seconds confirmed!
          // Step 7: Display 'Welcome!' and 'Send Name on BT' on the LCD
          currentState = STATE_AWAITING_INPUT;
          lastActivityTime = currentMillis;
          showLCD("Welcome!", "Send Name on BT");
          SerialBT.println("Hello! Welcome to Room Track Bot. Please type patient name to search:");

          // Play Welcome Audio (English & Tamil)
          playTrack(1); // 0001.mp3: Welcome English
          playTrack(2); // 0002.mp3: Welcome Tamil
        }
      }
    } else {
      // Person walked away before 2 seconds completed
      if (currentState == STATE_CONFIRMING_PERSON) {
        setStandbyScreen(); // Revert back to Step 3
      }
    }
  }

  delay(25); // Step 17: Endless loop
}
