import json
from urllib import request
from datetime import datetime

def fetch_weather_data(start_date: str, end_date: str) -> dict:
    """
    Fetch weather data using only standard Python libraries.
    Returns a dictionary with daily weather data.
    """
    base_url = "https://archive-api.open-meteo.com/v1/archive"
    params = f"latitude=40.4165&longitude=-3.7026&start_date={start_date}&end_date={end_date}&daily=temperature_2m_mean,temperature_2m_max,temperature_2m_min,daylight_duration,precipitation_sum&timezone=Europe%2FBerlin"
    
    url = f"{base_url}?{params}"
    
    try:
        with request.urlopen(url) as response:
            data = json.loads(response.read().decode())
        
        # Create a list of daily weather dictionaries
        daily_data = []
        for i in range(len(data['daily']['time'])):
            daily_data.append({
                'date': data['daily']['time'][i],
                'mean_temp': data['daily']['temperature_2m_mean'][i],
                'max_temp': data['daily']['temperature_2m_max'][i],
                'min_temp': data['daily']['temperature_2m_min'][i],
                'daylight_hours': round(data['daily']['daylight_duration'][i] / 3600, 2),
                'precipitation': data['daily']['precipitation_sum'][i]
            })
        
        return daily_data
    
    except Exception as e:
        print(f"Error fetching weather data: {e}")
        return None

def lambda_handler(event, context):
    """
    AWS Lambda handler function.
    Expects event to contain 'start_date' and 'end_date' parameters.
    """
    start_date = event.get('start_date', '2025-03-25')
    end_date = event.get('end_date', '2025-04-08')
    
    weather_data = fetch_weather_data(start_date, end_date)
    
    if weather_data is not None:
        return {
            'statusCode': 200,
            'body': json.dumps(weather_data)
        }
    else:
        return {
            'statusCode': 500,
            'body': json.dumps('Error fetching weather data')
        }

# Example of how the response data will look:
"""
{
    'statusCode': 200,
    'body': [
        {
            'date': '2025-03-25',
            'mean_temp': 12.3,
            'max_temp': 18.1,
            'min_temp': 6.5,
            'daylight_hours': 12.35,
            'precipitation': 0.0
        },
        ...
    ]
}
"""
