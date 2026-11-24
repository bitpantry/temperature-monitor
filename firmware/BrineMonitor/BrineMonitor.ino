#include <ESP8266WiFi.h>
#include <ESP8266HTTPClient.h>
#include <WiFiClientSecureBearSSL.h>
#include <OneWire.h>
#include <DallasTemperature.h>
#include <time.h>
extern "C" {
#include <user_interface.h>
}
#if __has_include("Secrets.h")
#include "Secrets.h"
#else
#include "Secrets.example.h"
#endif

OneWire wire(D5);
DallasTemperature probes(&wire);
enum class Light { Off, Yellow, Green, Red, Blue };
const uint8_t ledPins[]={D1,D2,D6};
constexpr uint8_t ledBrightness=96, yellowGreen=48;
constexpr uint32_t sendBlinkMs=220;
bool sendBlink=false;
uint32_t sendBlinkUntil=0;
constexpr uint32_t minuteMs=60000, retryMs=15000, timeoutMs=8000, pendingMaxMs=75000, greenMaxMs=73000;
constexpr time_t minEpoch=1735689600UL;
struct Pending { bool present=false; float f=0; uint32_t sampledAt=0; char id[64]={}; } pending;
char bootId[36];
uint32_t sequence=0, nextAttempt=0, nextSample=0;
bool conversion=false, lastAccepted=false;
uint32_t acceptedSampleAt=0;
uint32_t readyAt=0;
bool due(uint32_t at) { return int32_t(millis()-at)>=0; }
void renderLight(Light state){
  const uint8_t levels[]={
    (state==Light::Red || state==Light::Yellow) ? ledBrightness : uint8_t(0),
    state==Light::Green ? ledBrightness : (state==Light::Yellow ? yellowGreen : uint8_t(0)),
    state==Light::Blue ? ledBrightness : uint8_t(0)
  };
  for(unsigned i=0;i<3;++i)
    analogWrite(ledPins[i], BRINE_COMMON_ANODE ? 255-levels[i] : levels[i]);
}
void light(Light state){
  sendBlink=false;
  if(state!=Light::Green)lastAccepted=false;
  renderLight(state);
}
bool settingsReady(){
  const String url=BRINE_INGEST_URL;
  return *BRINE_SSID && *BRINE_INGEST_KEY && *BRINE_CA_PEM && url.startsWith("https://") && url.endsWith("/api/readings");
}
void dropAfter(uint32_t delayMs){
  pending.present=false;
  nextSample=millis()+delayMs;
}
void sendPending(){
  BearSSL::WiFiClientSecure tls;
  BearSSL::X509List anchor(BRINE_CA_PEM);
  tls.setTrustAnchors(&anchor);
  tls.setX509Time(time(nullptr));
  tls.setTimeout(timeoutMs);
  HTTPClient http;
  http.setTimeout(timeoutMs);
  http.setFollowRedirects(HTTPC_DISABLE_FOLLOW_REDIRECTS);
  if(!http.begin(tls,BRINE_INGEST_URL)){light(Light::Red);Serial.println("HTTPS startup failed");return;}
  http.addHeader("Content-Type","application/json");
  http.addHeader("Authorization",String("Bearer ")+BRINE_INGEST_KEY);
  // Only an optional narrow transport credential for a purpose-built relay;
  // never put a Site-wide or account-wide bearer token here.
  if(*BRINE_INGRESS_KEY) http.addHeader("X-Brine-Ingress-Key",BRINE_INGRESS_KEY);
  char json[112];
  snprintf(json,sizeof(json),"{\"id\":\"%s\",\"tempF\":%.3f}",pending.id,pending.f);
  const int code=http.POST(reinterpret_cast<uint8_t*>(json),strlen(json));
  String body;
  if((code==200 || code==201 || code==409) && http.getSize()>=0 && http.getSize()<=200) body=http.getString();
  http.end();
  body.replace(" ",""); body.replace("\n",""); body.replace("\r",""); body.replace("\t","");
  if((code==201 && body.startsWith("{\"stored\":true,\"at\":") && body.endsWith("}")) || (code==200 && body=="{\"stored\":false,\"duplicate\":true}")){
    if(millis()-pending.sampledAt<greenMaxMs){
      const bool blink=lastAccepted && code==201;
      light(blink ? Light::Blue : Light::Green);
      lastAccepted=true;acceptedSampleAt=pending.sampledAt;
      if(blink){sendBlink=true;sendBlinkUntil=millis()+sendBlinkMs;}
    }else light(Light::Red);
    Serial.printf("Reading confirmed %.2f F\n",pending.f);
    const uint32_t age=millis()-pending.sampledAt;
    dropAfter(age<minuteMs?minuteMs-age:0);
  }else if(code==409 && (body.indexOf("\"paused\":true")>=0 || body.indexOf("\"error\":\"Monitoringisoff\"")>=0)){
    light(Light::Off);Serial.println("Monitoring is off");dropAfter(minuteMs);
  }else{
    light(Light::Red);Serial.printf("Reading not confirmed, HTTP %d\n",code);
    // A retry repeats the same ID, including when the response was lost.
    // Continue serially; do not queue or post later readings ahead of it.
  }
}
void setup(){
  for(auto pin:ledPins){digitalWrite(pin,BRINE_COMMON_ANODE?HIGH:LOW);pinMode(pin,OUTPUT);}
  analogWriteRange(255);
  light(Light::Yellow);Serial.begin(115200);
  snprintf(bootId,sizeof(bootId),"%06lx-%08lx-%08lx",(unsigned long)ESP.getChipId(),(unsigned long)os_random(),(unsigned long)os_random());
  probes.begin();probes.setResolution(12);probes.setWaitForConversion(false);
  WiFi.persistent(false);
  if(!settingsReady()){WiFi.mode(WIFI_OFF);light(Light::Red);Serial.println("Setup required: copy Secrets.example.h to Secrets.h");return;}
  WiFi.mode(WIFI_STA);WiFi.setAutoReconnect(true);WiFi.begin(BRINE_SSID,BRINE_WIFI_PASSWORD);
  configTime(0,0,"time.cloudflare.com","pool.ntp.org");
}
void loop(){
  static const bool configured=settingsReady();
  if(!configured){delay(1000);return;}
  if(lastAccepted && millis()-acceptedSampleAt>=greenMaxMs) light(Light::Red);
  if(sendBlink && due(sendBlinkUntil)) light(Light::Green);
  if(pending.present && millis()-pending.sampledAt>=pendingMaxMs){
    light(Light::Red);Serial.println("Expired unconfirmed sample; taking a fresh measurement");dropAfter(0);
  }
  if(!pending.present && !conversion && due(nextSample)){
    probes.begin();probes.setResolution(12);
    if(probes.getDS18Count()!=1){
      light(Light::Red);Serial.println("Expected exactly one DS18B20");nextSample=millis()+retryMs;
    }else{
      probes.requestTemperatures();readyAt=millis()+800;conversion=true;
    }
  }
  if(conversion && due(readyAt)){
    conversion=false;
    const float c=probes.getTempCByIndex(0); // library checks scratchpad/CRC
    if(!isfinite(c)||c< -55 || c>125 || c==85.0f){
      light(Light::Red);Serial.println("Invalid DS18B20 conversion; skipped");nextSample=millis()+retryMs;
    }else{
      pending.present=true;pending.f=DallasTemperature::toFahrenheit(c);pending.sampledAt=millis();
      snprintf(pending.id,sizeof(pending.id),"%s:%lu",bootId,(unsigned long)++sequence);
      nextAttempt=millis();
    }
  }
  if(pending.present && due(nextAttempt)){
    if(WiFi.status()!=WL_CONNECTED || time(nullptr)<minEpoch){
      light(millis()<30000?Light::Yellow:Light::Red);
      Serial.println("Waiting for Wi-Fi and synchronized UTC");
    } else sendPending();
    nextAttempt=millis()+retryMs;
  }
  delay(25);
}
