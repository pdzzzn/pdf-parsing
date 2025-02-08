import fs from 'fs';
import path from 'path';
import pdf from 'pdf-parse';
import { v4 as uuidv4 } from 'uuid';

// Types
interface LogEntry {
    type: LogType;
    message: string;
    line?: string;
    context?: any;
    timestamp: Date;
}

enum LogType {
    UNPARSEABLE = 'UNPARSEABLE',
    EDGE_CASE = 'EDGE_CASE',
    IGNORED = 'IGNORED',
    WARNING = 'WARNING'
}

interface Duty {
    id: string;
    date: string;
    type: string;
    flightNumber: string;
    departureStation: string | null;
    arrivalStation: string | null;
    departureTime: string;
    arrivalTime: string;
    annotation: string | null;
}

// Logger class remains the same as in original
class Logger {
    private logs: LogEntry[] = [];

    private addLog(type: LogType, message: string, line?: string, context?: any) {
        this.logs.push({
            type,
            message,
            line,
            context,
            timestamp: new Date()
        });
    }

    logUnparseable(line: string, reason: string) {
        this.addLog(LogType.UNPARSEABLE, `Failed to parse line: ${reason}`, line);
    }

    logEdgeCase(line: string, handling: string) {
        this.addLog(LogType.EDGE_CASE, `Edge case handled: ${handling}`, line);
    }

    logIgnored(line: string, reason: string) {
        this.addLog(LogType.IGNORED, `Ignored line: ${reason}`, line);
    }

    logWarning(message: string, context?: any) {
        this.addLog(LogType.WARNING, message, undefined, context);
    }

    getLogs(): LogEntry[] {
        return this.logs;
    }
}

// Main parser class (mostly unchanged)
class DutyRosterParser {
    private content: string = '';
    private period: { startDate: Date; endDate: Date };
    private logger: Logger;
    private userID: string = '';

    // Using patterns from main.ts
    private patterns = {
        pattern_period: /(?<=Period:).*?(?=contract)/g,
        offPattern: /([A-Z][a-z]{2}\d\d)(O_[M,S,V,TZ])/g,
        stbyPattern: /([A-Z][a-z]{2}\d\d)(STBY_S\d)([A-Z]{3})(\d{4})(\d{4})/g,
        dutyBlockPattern: /[A-Z][a-z]{2}\d\d(?:PickUp|C\/I)(?:.*?)\[FDP\d\d:\d\d\]/g,
        dutyPattern: /((?:DH\/)?[A-Z]{2}\d{4}|\d{3})(?:R?)([A-Z]{3})(\d{8})([A-Z]{3})/g,
        flightTimePattern: /Flighttime\d{2}/g,
        userIDPattern: /\((\d{6})\)/g,
        headerPattern: /Individualdutyplanfor.*?dateHdutyRdeparrACinfodateHdutyRdeparrACinfodateHdutyRdeparrACinfo/g
    };

    constructor(private pdfBuffer: Buffer) {
        this.logger = new Logger();
        this.period = {
            startDate: new Date(),
            endDate: new Date()
        };
    }

    private parseDateString(dateStr: string): Date {
        const dayOfWeekMap: { [key: string]: number } = {
            'Sun': 0, 'Mon': 1, 'Tue': 2, 'Wed': 3, 
            'Thu': 4, 'Fri': 5, 'Sat': 6
        };
        
        const dayOfWeek = dateStr.slice(0, 3);
        const dayOfMonth = parseInt(dateStr.slice(3));
        
        if (!dayOfWeekMap.hasOwnProperty(dayOfWeek) || 
            isNaN(dayOfMonth) || 
            dayOfMonth < 1 || 
            dayOfMonth > 31) {
            this.logger.logWarning('Invalid date string format', { dateStr });
            throw new Error('Invalid date string format');
        }
        
        let testDate = new Date(Date.UTC(
            this.period.startDate.getUTCFullYear(),
            this.period.startDate.getUTCMonth(),
            dayOfMonth,
            0, 0, 0, 0
        ));
        
        let monthsToTry = 2;
        let currentMonth = this.period.startDate.getUTCMonth();
        
        while (monthsToTry > 0) {
            testDate.setUTCMonth(currentMonth);
            testDate.setUTCDate(dayOfMonth);
            
            if (testDate.getUTCDay() === dayOfWeekMap[dayOfWeek]) {
                break;
            }
            
            currentMonth++;
            monthsToTry--;
        }
        
        const testDateDay = new Date(Date.UTC(
            testDate.getUTCFullYear(),
            testDate.getUTCMonth(),
            testDate.getUTCDate()
        ));
        const periodStartDay = new Date(Date.UTC(
            this.period.startDate.getUTCFullYear(),
            this.period.startDate.getUTCMonth(),
            this.period.startDate.getUTCDate()
        ));
        const periodEndDay = new Date(Date.UTC(
            this.period.endDate.getUTCFullYear(),
            this.period.endDate.getUTCMonth(),
            this.period.endDate.getUTCDate() + 1
        ));
        
        if (testDateDay < periodStartDay || testDateDay > periodEndDay) {
            this.logger.logWarning('Date outside of valid period range', {
                date: dateStr,
                testDateDay: testDateDay.toISOString(),
                periodStartDay: periodStartDay.toISOString(),
                periodEndDay: periodEndDay.toISOString()
            });
            throw new Error('Date outside of valid period range');
        }
        
        return testDate;
    }

    private parseCustomDate(dateStr: string): Date {
        const months: { [key: string]: number } = {
            'Jan': 0, 'Feb': 1, 'Mar': 2, 'Apr': 3, 'May': 4, 'Jun': 5,
            'Jul': 6, 'Aug': 7, 'Sep': 8, 'Oct': 9, 'Nov': 10, 'Dec': 11
        };
     
        const day = parseInt(dateStr.substring(0, 2));
        const month = dateStr.substring(2, 5);
        const year = parseInt(dateStr.substring(5, 7));
     
        if (isNaN(day) || !months.hasOwnProperty(month) || isNaN(year)) {
            this.logger.logWarning('Invalid date format', { dateStr });
            throw new Error(`Invalid date format: ${dateStr}`);
        }
     
        return new Date(Date.UTC(2000 + year, months[month], day));
    }

    private generateUID(duty: RegExpMatchArray, date: Date): string {
        const l = date.toLocaleString('en-GB', { timeZone: 'UTC' }).split(',')[0].replace(/\//g, '-');
        return this.userID + '/' + l + '/' + duty[0];
    }

    private parsePeriodID(text: string): void {
        try {
            const dutyPeriod = this.patterns.pattern_period.exec(text);
            if (!dutyPeriod) {
                this.logger.logWarning('Could not find duty period in text');
                throw new Error('Could not find duty period in text');
            }
            this.period.startDate = this.parseCustomDate(dutyPeriod[0].slice(0,7));
            this.period.endDate = this.parseCustomDate(dutyPeriod[0].slice(8,15));

            const userIDMatch = this.patterns.userIDPattern.exec(text);
            if (!userIDMatch) {
                this.logger.logWarning('Could not find user ID in text');
                throw new Error('Could not find user ID in text');
            }
            this.userID = userIDMatch[1];
            this.logger.logEdgeCase('Period and UserID', `Found period: ${this.period.startDate.toISOString()} - ${this.period.endDate.toISOString()}, UserID: ${this.userID}`);
        } catch (err) {
            this.logger.logWarning('Error in parsePeriodID', { error: err });
            throw err;
        }
    }

    private cleanText(text: string): string {
        try {
            if (!text) {
                this.logger.logWarning('Input text is empty or undefined');
                throw new Error('Input text is empty or undefined');
            }
            
            text = text.replace(/\n/g, '');
            text = text.replace(/\s+/g,'');
            return text;
        } catch (err) {
            this.logger.logWarning('Error cleaning text', { error: err });
            throw err;
        }
    }

    private processText(text: string): string {
        try {
            if (!text) {
                this.logger.logWarning('Input text is empty or undefined');
                throw new Error('Input text is empty or undefined');
            }
            
            const flightTimeMatches = text.match(this.patterns.flightTimePattern);
            if (!flightTimeMatches) {
                this.logger.logWarning('No flight time pattern found for splitting text');
            }
            
            text = text.split(this.patterns.flightTimePattern)[0];
            
            if (!text) {
                this.logger.logWarning('Text is empty after splitting at flight time pattern');
                throw new Error('Text is empty after splitting at flight time pattern');
            }
            
            text = text.replace(this.patterns.headerPattern, '');
            
            if (!text.trim()) {
                this.logger.logWarning('Text is empty after removing header pattern');
                throw new Error('Text is empty after removing header pattern');
            }
            
            return text;
        } catch (err) {
            this.logger.logWarning('Error in processText', { error: err });
            throw err;
        }
    }

    private parseText(text: string): Duty[] {
        try {
            const dutyArray: Duty[] = [];
            const offArray = Array.from(text.matchAll(this.patterns.offPattern));
            const stbyArray = Array.from(text.matchAll(this.patterns.stbyPattern));
            const flightBlockArray = Array.from(text.matchAll(this.patterns.dutyBlockPattern));

            // Parse OFF duties
            for (const duty of offArray) {
                try {
                    const currentDate = this.parseDateString(duty[1]);
                    const endTime = currentDate.toISOString().split('T')[0] + 'T23:59:59.999Z';
                    dutyArray.push({
                        id: uuidv4(),
                        date: currentDate.toISOString().split('T')[0],
                        type: duty[2],
                        flightNumber: duty[2],
                        departureStation: null,
                        arrivalStation: null,
                        departureTime: currentDate.toISOString(),
                        arrivalTime: endTime,
                        annotation: null
                    });
                    this.logger.logEdgeCase('OFF duty', `Processed OFF duty for date: ${currentDate.toISOString()}`);
                } catch (err) {
                    this.logger.logWarning('Error parsing OFF duty', { error: err, duty });
                }
            }

            // Parse Standby duties
            for (const duty of stbyArray) {
                try {
                    const currentDate = this.parseDateString(duty[1]);
                    dutyArray.push({
                        id: uuidv4(),
                        date: currentDate.toISOString().split('T')[0],
                        type: duty[2],
                        flightNumber: duty[2],
                        departureStation: duty[3],
                        arrivalStation: duty[3],
                        departureTime: this.parseTimeToISO(currentDate, duty[4]),
                        arrivalTime: this.parseTimeToISO(currentDate, duty[5]),
                        annotation: null
                    });
                    this.logger.logEdgeCase('Standby duty', `Processed STBY duty for date: ${currentDate.toISOString()}`);
                } catch (err) {
                    this.logger.logWarning('Error parsing STBY duty', { error: err, duty });
                }
            }

            // Parse Flight duties
            for (const block of flightBlockArray) {
                try {
                    const duties = Array.from(block[0].matchAll(this.patterns.dutyPattern));
                    const currentDate = this.parseDateString(block[0].slice(0,5));

                    for (const flight of duties) {
                        try {
                            const depTime = flight[3].slice(0, 4);
                            const arrTime = flight[3].slice(4);
                            
                            let flightDate = new Date(currentDate);
                            if (parseInt(arrTime) < parseInt(depTime)) {
                                flightDate.setUTCDate(flightDate.getUTCDate() + 1);
                            }

                            dutyArray.push({
                                id: uuidv4(),
                                date: currentDate.toISOString().split('T')[0],
                                type: flight[0].includes('DH') ? 'DH' : 'FLIGHT',
                                flightNumber: flight[1],
                                departureStation: flight[2],
                                arrivalStation: flight[4],
                                departureTime: this.parseTimeToISO(currentDate, depTime),
                                arrivalTime: this.parseTimeToISO(flightDate, arrTime),
                                annotation: null
                            });
                            this.logger.logEdgeCase('Flight duty', `Processed flight: ${flight[1]} for date: ${currentDate.toISOString()}`);
                        } catch (err) {
                            this.logger.logWarning('Error parsing individual flight', { error: err, flight });
                        }
                    }
                } catch (err) {
                    this.logger.logWarning('Error processing flight block', { error: err, block });
                }
            }

            dutyArray.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
            return dutyArray;
        } catch (err) {
            this.logger.logWarning('Error in parseText', { error: err });
            throw err;
        }
    }

    private parseTimeToISO(date: Date, time: string): string {
        const hours = parseInt(time.substring(0, 2));
        const minutes = parseInt(time.substring(2, 4));
        
        const isoDate = new Date(date);
        isoDate.setUTCHours(hours, minutes, 0, 0);
        
        return isoDate.toISOString();
    }

    public async parse(): Promise<{ duties: Duty[], logs: LogEntry[] }> {
        try {
            const data = await pdf(this.pdfBuffer);
            this.content = data.text;
            
            this.content = this.cleanText(this.content);
            this.parsePeriodID(this.content);
            this.content = this.processText(this.content);
            fs.writeFileSync('output.txt', this.content);
            const duties = this.parseText(this.content);

            const stats = {
                total: duties.length,
                flights: duties.filter(d => d.type === 'FLIGHT').length,
                deadheads: duties.filter(d => d.type === 'DH').length,
                standby: duties.filter(d => d.type.startsWith('STBY')).length,
                off: duties.filter(d => d.type.startsWith('O_')).length
            };

            this.logger.logEdgeCase('Summary', 
                `Processed ${stats.total} duties: ` +
                `${stats.flights} flights, ` +
                `${stats.deadheads} deadheads, ` +
                `${stats.standby} standby, ` +
                `${stats.off} off days`
            );

            return {
                duties,
                logs: this.logger.getLogs()
            };
        } catch (error) {
            this.logger.logWarning('Failed to parse PDF', { error });
            throw error;
        }
    }
}

// New function to process directory
async function processDirectory(dirPath: string): Promise<void> {
    try {
        const files = await fs.promises.readdir(dirPath);
        const pdfFiles = files.filter(file => path.extname(file).toLowerCase() === '.pdf');
        
        console.log(`Found ${pdfFiles.length} PDF files to process`);
        
        for (const file of pdfFiles) {
            console.log(`\nProcessing ${file}...`);
            const filePath = path.join(dirPath, file);
            const pdfBuffer = await fs.promises.readFile(filePath);
            
            const parser = new DutyRosterParser(pdfBuffer);
            try {
                const result = await parser.parse();
                
                // Create output directory if it doesn't exist
                const outputDir = path.join(dirPath, 'output');
                await fs.promises.mkdir(outputDir, { recursive: true });
                
                // Save duties and logs
                const outputBase = path.join(outputDir, path.basename(file, '.pdf'));
                await fs.promises.writeFile(
                    `${outputBase}_duties.json`, 
                    JSON.stringify(result.duties, null, 2)
                );
                await fs.promises.writeFile(
                    `${outputBase}_logs.json`, 
                    JSON.stringify(result.logs, null, 2)
                );
                
                console.log(`Successfully processed ${file}`);
            } catch (error) {
                console.error(`Error processing ${file}:`, error);
            }
        }
    } catch (error) {
        console.error('Error processing directory:', error);
    }
}


function main() {

    // C:\Users\Patri\Desktop\Coding\Parser\CascadeProjects\windsurf-project\pdf
    processDirectory('C:\\Users\\Patri\\Desktop\\Coding\\Parser\\CascadeProjects\\windsurf-project\\pdf').catch(console.error);

}

main();  
