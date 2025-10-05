## Description
A webpage where cleaning teams can log in and complete a cleaning checklist when they visit a laundromat to clean it. The data collected thru the app will be saved in Notion and googlesheets, so that management can audit the site visits.

## Requirements
- the webpage UI **MUST** be responsive so it works well on mobile phones.
- the webpage **MUST** support branching logic, so that if user chooses action X, then the prompt for action Y is shown.
- each item in the checklist **MUST** have the ability to link a youtube video (so that the user can see a demonstration of how it is done) and be able to support helper text if needed.
- The output of each item **MUST** be stored in a raw format in googlesheets and in a summary format in Notion.
- Some of the items **MUST** ask the cleaner for a photo as proof of the work they have done. 
- We **MUST** create an MVP. Do NOT consider "nice to have" requirements outside of those in this file.

## Users
- Cleaner: user who inputs data as they clean the laundromat.
- Manager: user who audits the data the cleaner has uploaded to track their work.

## User stories
- As a cleaner, I want to easily navigate this website.
- As a cleaner, I want to find instructions if I don't know how to do a task.
- As a cleaner, I want the website to remember where I was before I hit "submit" (in session), so that I can fill out progress as I do the tasks. 
- As a manager, I want to be able to see the photos taken from each visit. Prefferably in Notion.
- As a manager, I want to have a single database in Notion where I can see all the site visits in aggregate and what the cleaners did.


## Technical requirements
- The app or website **MUST** be able to be hosted in a static github site.
- The app or website **MUST** use AWS services, such as lambda functions, to update the backend databases.
- The app or website **MUST** prioritize speed and ease of submit of data, by saving asynchronously all the backend services.
- The app or website **MUST** be highly stable, depending on as few services as possible and provide error handling.
- The code in the app or website **MUST** have highly detailed comments, so that it can be refined or adjusted later.